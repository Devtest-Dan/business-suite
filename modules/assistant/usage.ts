import "server-only";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import { db } from "@/lib/db/client";
import { UserError } from "@/lib/errors";
import type { Viewer } from "@/lib/modules/contract";
import { notify, usersWithPermission } from "@/lib/notifications";
import { assistantSettingsRow } from "./facts";
import { MODULE_ID, P } from "./ids";
import { assistantSettings, assistantUsage } from "./schema";

/**
 * The monthly cap the owner sets: a token limit, and/or a spend limit worked
 * out from the owner's own prices (per million tokens, from their provider's
 * price page). Usage is counted per person per UTC month from what the
 * provider reports for each model call.
 */

export function monthOf(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export interface Limits {
  monthlyTokenCap: number | null;
  monthlySpendCap: number | null;
  pricePerMillionIn: number | null;
  pricePerMillionOut: number | null;
  currency: string;
}

export interface MonthUsage {
  month: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when the owner has not entered both prices. */
  spend: number | null;
}

const num = (v: string | number | null): number | null => (v === null || v === undefined ? null : Number(v));

export async function readLimits(): Promise<Limits> {
  const s = await assistantSettingsRow();
  return {
    monthlyTokenCap: num(s.monthlyTokenCap),
    monthlySpendCap: num(s.monthlySpendCap),
    pricePerMillionIn: num(s.pricePerMillionIn),
    pricePerMillionOut: num(s.pricePerMillionOut),
    currency: s.currency,
  };
}

/** Pure: the estimated spend for some tokens at the owner's prices, or null without both prices. */
export function spendFor(limits: Pick<Limits, "pricePerMillionIn" | "pricePerMillionOut">, inputTokens: number, outputTokens: number): number | null {
  if (limits.pricePerMillionIn === null || limits.pricePerMillionOut === null) return null;
  return (inputTokens / 1e6) * limits.pricePerMillionIn + (outputTokens / 1e6) * limits.pricePerMillionOut;
}

/** Pure: which limit (if any) this month's usage has reached. */
export function capReached(limits: Limits, usage: Pick<MonthUsage, "inputTokens" | "outputTokens">): "tokens" | "spend" | null {
  if (limits.monthlyTokenCap !== null && usage.inputTokens + usage.outputTokens >= limits.monthlyTokenCap) return "tokens";
  const spend = spendFor(limits, usage.inputTokens, usage.outputTokens);
  if (limits.monthlySpendCap !== null && spend !== null && spend >= limits.monthlySpendCap) return "spend";
  return null;
}

/** Pure: the share of the tighter limit used, 0..1+, or null with no limit. */
export function shareUsed(limits: Limits, usage: Pick<MonthUsage, "inputTokens" | "outputTokens">): number | null {
  const shares: number[] = [];
  if (limits.monthlyTokenCap) shares.push((usage.inputTokens + usage.outputTokens) / limits.monthlyTokenCap);
  const spend = spendFor(limits, usage.inputTokens, usage.outputTokens);
  if (limits.monthlySpendCap && spend !== null) shares.push(spend / limits.monthlySpendCap);
  return shares.length ? Math.max(...shares) : null;
}

export async function monthUsage(month = monthOf(), limits?: Limits): Promise<MonthUsage> {
  const [row] = await db()
    .select({
      calls: sql<number>`coalesce(sum(${assistantUsage.calls}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${assistantUsage.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${assistantUsage.outputTokens}), 0)::bigint`,
    })
    .from(assistantUsage)
    .where(eq(assistantUsage.month, month));
  const l = limits ?? (await readLimits());
  const inputTokens = Number(row?.inputTokens ?? 0);
  const outputTokens = Number(row?.outputTokens ?? 0);
  return { month, calls: Number(row?.calls ?? 0), inputTokens, outputTokens, spend: spendFor(l, inputTokens, outputTokens) };
}

export async function usageByPerson(month = monthOf()): Promise<{ userId: string; name: string; calls: number; tokens: number }[]> {
  const rows = await db().execute<{ user_id: string; name: string; calls: number; tokens: string }>(sql`
    select u.user_id, coalesce(us.name, 'Former member') as name, u.calls, (u.input_tokens + u.output_tokens)::text as tokens
    from assistant_usage u left join users us on us.id = u.user_id
    where u.month = ${month} order by u.input_tokens + u.output_tokens desc limit 50`);
  return rows.map((r) => ({ userId: r.user_id, name: r.name, calls: Number(r.calls), tokens: Number(r.tokens) }));
}

/** Called before every model call: refuses when this month's limit is reached. */
export async function assertUnderCap(): Promise<void> {
  const limits = await readLimits();
  if (limits.monthlyTokenCap === null && limits.monthlySpendCap === null) return;
  const usage = await monthUsage(monthOf(), limits);
  const which = capReached(limits, usage);
  if (!which) return;
  await tellOwnersOnce(which);
  throw new UserError(
    which === "tokens"
      ? "The assistant has used this month's token limit the owner set, so it is paused until next month. The owner can raise the limit in Assistant → Settings."
      : "The assistant has reached this month's spend limit the owner set, so it is paused until next month. The owner can raise the limit in Assistant → Settings.",
  );
}

/** Called after every model call with what the provider reported. */
export async function recordUsage(viewer: Viewer, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
  const month = monthOf();
  await db()
    .insert(assistantUsage)
    .values({ month, userId: viewer.id, calls: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
    .onConflictDoUpdate({
      target: [assistantUsage.month, assistantUsage.userId],
      set: {
        calls: sql`${assistantUsage.calls} + 1`,
        inputTokens: sql`${assistantUsage.inputTokens} + ${usage.inputTokens}`,
        outputTokens: sql`${assistantUsage.outputTokens} + ${usage.outputTokens}`,
      },
    });
}

/** One notice per month to the people who set the limits. */
async function tellOwnersOnce(which: "tokens" | "spend"): Promise<void> {
  const month = monthOf();
  const claimed = await db()
    .update(assistantSettings)
    .set({ notifiedMonth: month })
    .where(and(eq(assistantSettings.id, 1), or(isNull(assistantSettings.notifiedMonth), ne(assistantSettings.notifiedMonth, month))))
    .returning({ id: assistantSettings.id });
  if (claimed.length === 0) return;
  await notify(await usersWithPermission(P.limits), {
    kind: "assistant.limit_reached",
    title: which === "tokens" ? "The assistant reached this month's token limit" : "The assistant reached this month's spend limit",
    body: "It is paused for everyone until next month, or until you raise the limit.",
    url: `/m/${MODULE_ID}/settings`,
  });
}

export async function saveLimits(viewer: Viewer, input: Limits & { redactFacts: boolean }): Promise<void> {
  const values = {
    monthlyTokenCap: input.monthlyTokenCap === null ? null : Math.round(input.monthlyTokenCap),
    monthlySpendCap: input.monthlySpendCap === null ? null : input.monthlySpendCap.toFixed(2),
    pricePerMillionIn: input.pricePerMillionIn === null ? null : input.pricePerMillionIn.toFixed(4),
    pricePerMillionOut: input.pricePerMillionOut === null ? null : input.pricePerMillionOut.toFixed(4),
    currency: input.currency,
    redactFacts: input.redactFacts,
    // A new limit may be above this month's usage again: allow a new notice.
    notifiedMonth: null,
    updatedBy: viewer.id,
    updatedAt: new Date(),
  };
  await db().insert(assistantSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: assistantSettings.id, set: values });
  await audit({
    actor: userActor(viewer),
    action: "assistant.limits_changed",
    module: MODULE_ID,
    summary: `${viewer.name} changed the assistant's monthly limits (tokens: ${values.monthlyTokenCap ?? "none"}; spend: ${values.monthlySpendCap ? `${values.monthlySpendCap} ${values.currency}` : "none"}) and set personal details in facts to ${input.redactFacts ? "replaced" : "kept"}.`,
  });
}

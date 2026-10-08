import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, notInArray, sql } from "drizzle-orm";
import { after } from "next/server";
import { propose, type ProposeResult } from "@/lib/approvals/ledger";
import { audit, SYSTEM_ACTOR, userActor } from "@/lib/audit";
import { safeEqual } from "@/lib/crypto";
import { db, type Db, type DbTx } from "@/lib/db/client";
import { env } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { mailConfigured, sendMail } from "@/lib/mail";
import type { ApplyContext, ApplyResult, ModuleContext } from "@/lib/modules/contract";
import { businessProfile } from "@/lib/settings";
import { addEvent, getLead, getSettings, MODULE_ID, stopSequences, type Lead } from "./data";
import { emailFooter, firstName, renderTemplate } from "./logic";
import { funnelEnrollments, funnelLeads, funnelSends, funnelSequences, funnelSequenceSteps } from "./schema";
import type { EnrollInput, SequenceInput } from "./schemas";

/**
 * Follow-up email sequences. A person enrols leads; that is ONE approval for
 * the whole batch. The approved enrolment writes one row per email with its
 * due time; due emails are sent with the owner's SMTP (lib/mail.ts) when the
 * suite next runs due work (see `kickDueEmails`). Each email is claimed with
 * one conditional UPDATE, so it is sent once even if two runs overlap.
 *
 * Every email carries the business's postal address and an unsubscribe link
 * (CAN-SPAM). A sequence cannot be switched on without a postal address.
 * Email only: text messages are never sent from here.
 */

type Q = Db | DbTx;
export type Sequence = typeof funnelSequences.$inferSelect;
export type Step = typeof funnelSequenceSteps.$inferSelect;

/** Statuses a lead may be in to get (or keep getting) sequence emails. */
export const SENDABLE_STATUSES = ["new", "qualified"] as const;
/** Emails sent per run, so one page load never waits long. */
export const SEND_BATCH = 20;
const STALE_SENDING_MINUTES = 10;

// ── Sequences ───────────────────────────────────────────────────────────────

export async function listSequences(q: Q) {
  const rows = await q.select().from(funnelSequences).orderBy(asc(funnelSequences.name));
  if (!rows.length) return [];
  const steps = await q
    .select({ sequenceId: funnelSequenceSteps.sequenceId, n: count(), lastDay: sql<number>`max(${funnelSequenceSteps.delayDays})::int` })
    .from(funnelSequenceSteps)
    .groupBy(funnelSequenceSteps.sequenceId);
  const active = await q
    .select({ sequenceId: funnelEnrollments.sequenceId, n: count() })
    .from(funnelEnrollments)
    .where(eq(funnelEnrollments.status, "active"))
    .groupBy(funnelEnrollments.sequenceId);
  return rows.map((s) => ({
    ...s,
    steps: steps.find((x) => x.sequenceId === s.id)?.n ?? 0,
    lastDay: steps.find((x) => x.sequenceId === s.id)?.lastDay ?? 0,
    activeLeads: active.find((x) => x.sequenceId === s.id)?.n ?? 0,
  }));
}

export async function getSequence(q: Q, id: string): Promise<(Sequence & { steps: Step[] }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await q.select().from(funnelSequences).where(eq(funnelSequences.id, id));
  if (!row) return null;
  const steps = await q.select().from(funnelSequenceSteps).where(eq(funnelSequenceSteps.sequenceId, id)).orderBy(asc(funnelSequenceSteps.position));
  return { ...row, steps };
}

/**
 * Creates or changes a sequence. Steps are kept by position, so emails already
 * scheduled pick up new wording. An email that has gone to someone cannot be
 * removed (its history would go with it): change its wording instead.
 */
export async function saveSequence(ctx: ModuleContext, input: SequenceInput): Promise<Sequence> {
  return ctx.db.transaction(async (tx) => {
    let seq: Sequence | undefined;
    if (input.id) {
      [seq] = await tx.update(funnelSequences).set({ name: input.name, updatedAt: new Date() }).where(eq(funnelSequences.id, input.id)).returning();
      if (!seq) throw new UserError("This sequence no longer exists. Reload the page.");
    } else {
      [seq] = await tx.insert(funnelSequences).values({ name: input.name, createdBy: ctx.viewer.id }).returning();
    }
    const existing = await tx.select().from(funnelSequenceSteps).where(eq(funnelSequenceSteps.sequenceId, seq.id));
    for (const [i, step] of input.steps.entries()) {
      const position = i + 1;
      const current = existing.find((s) => s.position === position);
      if (current) {
        await tx.update(funnelSequenceSteps).set(step).where(eq(funnelSequenceSteps.id, current.id));
        if (current.delayDays !== step.delayDays) {
          // Emails not sent yet move with the new day.
          await tx.execute(sql`
            update funnel_sends s set due_at = e.started_at + make_interval(days => ${step.delayDays})
            from funnel_enrollments e
            where e.id = s.enrollment_id and s.step_id = ${current.id} and s.status = 'scheduled'`);
        }
      } else {
        await tx.insert(funnelSequenceSteps).values({ ...step, sequenceId: seq.id, position });
      }
    }
    const removed = existing.filter((s) => s.position > input.steps.length);
    if (removed.length) {
      const [used] = await tx
        .select({ n: count() })
        .from(funnelSends)
        .where(and(inArray(funnelSends.stepId, removed.map((s) => s.id)), notInArray(funnelSends.status, ["scheduled", "cancelled"])));
      if (used.n > 0) throw new UserError("An email you removed has already gone to someone. Keep it (change its wording if you like), or make a new sequence.");
      await tx.delete(funnelSequenceSteps).where(inArray(funnelSequenceSteps.id, removed.map((s) => s.id)));
    }
    await audit(
      { actor: userActor(ctx.viewer), action: input.id ? "funnel.sequence_changed" : "funnel.sequence_added", module: MODULE_ID, target: { type: "sequence", id: seq.id }, summary: `${ctx.viewer.name} ${input.id ? "changed" : "added"} the email sequence "${seq.name}" (${input.steps.length} emails).` },
      tx,
    );
    return seq;
  });
}

export const NO_ADDRESS_MESSAGE =
  "Add your business's postal address in Leads → Settings first. US law (CAN-SPAM) requires it at the foot of every marketing email, so no sequence can be switched on without it.";

/** Switches a sequence on (needs a postal address and at least one email) or off (stops the emails not yet sent). */
export async function setSequenceActive(ctx: ModuleContext, id: string, active: boolean): Promise<Sequence> {
  const seq = await getSequence(ctx.db, id);
  if (!seq) throw new UserError("This sequence no longer exists. Reload the page.");
  if (active) {
    const settings = await getSettings(ctx.db);
    if (!settings.postalAddress.trim()) throw new UserError(NO_ADDRESS_MESSAGE);
    if (!seq.steps.length) throw new UserError("Write at least one email before switching the sequence on.");
  }
  const [row] = await ctx.db.update(funnelSequences).set({ active, updatedAt: new Date() }).where(eq(funnelSequences.id, id)).returning();
  let stopped = 0;
  if (!active) stopped = await stopEnrollmentsOf(ctx.db, [id], "the sequence was switched off");
  await audit({
    actor: userActor(ctx.viewer),
    action: "funnel.sequence_switched",
    module: MODULE_ID,
    target: { type: "sequence", id },
    summary: `${ctx.viewer.name} switched the sequence "${seq.name}" ${active ? "on" : `off${stopped ? ` (${stopped} lead${stopped === 1 ? "" : "s"} will get no more of its emails)` : ""}`}.`,
  });
  return row;
}

async function stopEnrollmentsOf(q: Q, sequenceIds: string[], reason: string): Promise<number> {
  if (!sequenceIds.length) return 0;
  const stopped = await q
    .update(funnelEnrollments)
    .set({ status: "stopped", stopReason: reason, stoppedAt: new Date() })
    .where(and(inArray(funnelEnrollments.sequenceId, sequenceIds), eq(funnelEnrollments.status, "active")))
    .returning({ id: funnelEnrollments.id });
  if (stopped.length) {
    await q
      .update(funnelSends)
      .set({ status: "cancelled" })
      .where(and(inArray(funnelSends.enrollmentId, stopped.map((s) => s.id)), eq(funnelSends.status, "scheduled")));
  }
  return stopped.length;
}

/** Switches every sequence off (the postal address was removed). */
export async function deactivateAllSequences(q: Q, reason: string): Promise<void> {
  const on = await q.update(funnelSequences).set({ active: false, updatedAt: new Date() }).where(eq(funnelSequences.active, true)).returning({ id: funnelSequences.id });
  await stopEnrollmentsOf(q, on.map((s) => s.id), reason);
}

export async function enrollmentsOfLead(q: Q, leadId: string) {
  return q
    .select({
      id: funnelEnrollments.id,
      sequenceId: funnelEnrollments.sequenceId,
      sequenceName: funnelSequences.name,
      status: funnelEnrollments.status,
      stopReason: funnelEnrollments.stopReason,
      startedAt: funnelEnrollments.startedAt,
      sent: sql<number>`(select count(*)::int from funnel_sends s where s.enrollment_id = ${funnelEnrollments.id} and s.status = 'sent')`,
      total: sql<number>`(select count(*)::int from funnel_sends s where s.enrollment_id = ${funnelEnrollments.id})`,
      nextAt: sql<Date | null>`(select min(s.due_at) from funnel_sends s where s.enrollment_id = ${funnelEnrollments.id} and s.status = 'scheduled')`,
    })
    .from(funnelEnrollments)
    .innerJoin(funnelSequences, eq(funnelSequences.id, funnelEnrollments.sequenceId))
    .where(eq(funnelEnrollments.leadId, leadId))
    .orderBy(asc(funnelEnrollments.startedAt));
}

/** The latest sends of a sequence, for its page. */
export async function recentSends(q: Q, sequenceId: string, limit = 50) {
  return q
    .select({
      id: funnelSends.id,
      position: funnelSends.position,
      status: funnelSends.status,
      dueAt: funnelSends.dueAt,
      sentAt: funnelSends.sentAt,
      error: funnelSends.error,
      leadId: funnelLeads.id,
      leadName: funnelLeads.name,
    })
    .from(funnelSends)
    .innerJoin(funnelEnrollments, eq(funnelEnrollments.id, funnelSends.enrollmentId))
    .innerJoin(funnelLeads, eq(funnelLeads.id, funnelEnrollments.leadId))
    .where(eq(funnelEnrollments.sequenceId, sequenceId))
    .orderBy(sql`coalesce(${funnelSends.sentAt}, ${funnelSends.dueAt}) desc`)
    .limit(limit);
}

// ── Unsubscribe links ───────────────────────────────────────────────────────

function unsubscribeSignature(leadId: string): string {
  const secret = env().secretKey;
  if (!secret) throw new Error("SUITE_SECRET_KEY is not set, so unsubscribe links cannot be signed.");
  return createHmac("sha256", `funnel-unsubscribe:${secret}`).update(leadId).digest("base64url");
}

export function unsubscribeToken(leadId: string): string {
  return `${leadId}.${unsubscribeSignature(leadId)}`;
}

/** The lead id a token was signed for, or null when it is not one of ours. */
export function verifyUnsubscribeToken(token: string): string | null {
  const [leadId, signature, extra] = token.split(".");
  if (extra !== undefined || !leadId || !signature || !/^[0-9a-f-]{36}$/i.test(leadId)) return null;
  return safeEqual(signature, unsubscribeSignature(leadId)) ? leadId : null;
}

export function unsubscribeUrl(leadId: string): string {
  return `${env().publicUrl}/api/m/${MODULE_ID}/unsubscribe/${unsubscribeToken(leadId)}`;
}

/** Records the opt-out and stops every sequence of the lead. Safe to call again. */
export async function unsubscribeLead(leadId: string): Promise<{ name: string; already: boolean } | null> {
  return db().transaction(async (tx) => {
    const [lead] = await tx.select({ id: funnelLeads.id, name: funnelLeads.name, unsubscribedAt: funnelLeads.unsubscribedAt }).from(funnelLeads).where(eq(funnelLeads.id, leadId));
    if (!lead) return null;
    if (lead.unsubscribedAt) return { name: lead.name, already: true };
    await tx.update(funnelLeads).set({ unsubscribedAt: new Date(), updatedAt: new Date() }).where(eq(funnelLeads.id, leadId));
    await stopSequences(tx, leadId, "the lead unsubscribed");
    await addEvent(tx, leadId, "unsubscribed", "Unsubscribed from the follow-up emails (through the link in an email). They get no more sequence emails.", "Unsubscribe link");
    await audit({ actor: { ...SYSTEM_ACTOR, name: "Unsubscribe link" }, action: "funnel.unsubscribed", module: MODULE_ID, target: { type: "lead", id: leadId }, summary: `The lead "${lead.name}" unsubscribed from the follow-up emails.` }, tx);
    return { name: lead.name, already: false };
  });
}

// ── Enrolment (one approval for the whole batch) ────────────────────────────

/** Why a lead cannot get sequence emails now, or null when it can. */
export function cannotEmail(lead: Pick<Lead, "email" | "unsubscribedAt" | "status" | "name">): string | null {
  if (!lead.email) return `${lead.name} has no email address`;
  if (lead.unsubscribedAt) return `${lead.name} unsubscribed from these emails`;
  if (!(SENDABLE_STATUSES as readonly string[]).includes(lead.status)) return `${lead.name} is ${lead.status} (sequences are for new and qualified leads that nobody is talking to yet)`;
  return null;
}

export interface EnrollProposal extends ProposeResult {
  skipped: string[];
}

/** Proposes sending a sequence to some leads: ONE approval, one record per lead. Leads that cannot get it are listed, not proposed. */
export async function proposeEnrollment(ctx: ModuleContext, sequenceId: string, leadIds: string[], source: "user" | "ai" = "user"): Promise<EnrollProposal> {
  const seq = await getSequence(ctx.db, sequenceId);
  if (!seq) throw new UserError("That sequence no longer exists. Pick another.");
  const settings = await getSettings(ctx.db);
  if (!settings.postalAddress.trim()) throw new UserError(NO_ADDRESS_MESSAGE);
  if (!seq.active) throw new UserError(`The sequence “${seq.name}” is switched off. Switch it on in Leads → Sequences first.`);
  if (!(await mailConfigured())) throw new UserError("Email is not set up, so no sequence email could go out. The owner adds the SMTP details in Settings → Email.");
  const leads = await ctx.db.select().from(funnelLeads).where(inArray(funnelLeads.id, [...new Set(leadIds)]));
  const already = new Set(
    (await ctx.db.select({ leadId: funnelEnrollments.leadId }).from(funnelEnrollments).where(and(eq(funnelEnrollments.sequenceId, sequenceId), inArray(funnelEnrollments.leadId, leadIds)))).map((r) => r.leadId),
  );
  const skipped: string[] = [];
  const items: EnrollInput[] = [];
  for (const lead of leads) {
    const why = already.has(lead.id) ? `${lead.name} was already enrolled in it` : cannotEmail(lead);
    if (why) skipped.push(why);
    else items.push({ leadId: lead.id, sequenceId, leadName: lead.name, sequenceName: seq.name });
  }
  const missing = leadIds.length - leads.length;
  if (missing > 0) skipped.push(`${missing} lead${missing === 1 ? " no longer exists" : "s no longer exist"}`);
  if (!items.length) throw new UserError(`None of these leads can get “${seq.name}”: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "; …" : ""}.`);
  const lastDay = seq.steps.at(-1)?.delayDays ?? 0;
  const result = await propose({
    action: `${MODULE_ID}.enroll`,
    items,
    source,
    requestedBy: ctx.viewer,
    title: `Send “${seq.name}” to ${items.length} lead${items.length === 1 ? "" : "s"}`,
    note: `${source === "ai" ? "The assistant proposes" : `${ctx.viewer.name} wants`} to send the sequence “${seq.name}” (${seq.steps.length} email${seq.steps.length === 1 ? "" : "s"} over ${lastDay} day${lastDay === 1 ? "" : "s"}) to ${items.length} lead${items.length === 1 ? "" : "s"}. Each email stops by itself if the lead replies, is contacted, converted or disqualified, or unsubscribes.${skipped.length ? ` Left out: ${skipped.slice(0, 5).join("; ")}${skipped.length > 5 ? "; …" : ""}.` : ""}`,
  });
  return { ...result, skipped };
}

export function previewEnroll(e: EnrollInput): string {
  return `Send the sequence ${e.sequenceName ? `“${e.sequenceName}”` : e.sequenceId.slice(0, 8)} to ${e.leadName || `lead ${e.leadId.slice(0, 8)}`}`;
}

/** The approved enrolment of one lead: the enrolment and one scheduled email per step. Checks everything again at write time. */
export async function applyEnroll(ctx: ApplyContext, input: EnrollInput): Promise<ApplyResult> {
  const by = ctx.requestedBy ?? ctx.approver;
  const settings = await getSettings(ctx.tx);
  if (!settings.postalAddress.trim()) throw new UserError(NO_ADDRESS_MESSAGE);
  const seq = await getSequence(ctx.tx, input.sequenceId);
  if (!seq) throw new UserError("The sequence no longer exists, so nothing was sent.");
  if (!seq.active) throw new UserError(`The sequence “${seq.name}” is switched off. Switch it on, then retry this record.`);
  if (!seq.steps.length) throw new UserError(`The sequence “${seq.name}” has no emails.`);
  const lead = await getLead(ctx.tx, input.leadId);
  if (!lead) throw new UserError("This lead no longer exists.");
  const why = cannotEmail(lead);
  if (why) throw new UserError(`Not enrolled: ${why}.`);

  const now = new Date();
  const [enrollment] = await ctx.tx
    .insert(funnelEnrollments)
    .values({ leadId: lead.id, sequenceId: seq.id, approvalId: ctx.approvalId, sourceKey: `${ctx.approvalId}:${ctx.dedupeKey}`, startedAt: now })
    .onConflictDoNothing()
    .returning();
  if (!enrollment) return { summary: `${lead.name} was already in “${seq.name}”: nothing is sent twice` };
  await ctx.tx.insert(funnelSends).values(
    seq.steps.map((s) => ({ enrollmentId: enrollment.id, stepId: s.id, position: s.position, dueAt: new Date(now.getTime() + s.delayDays * 86_400_000) })),
  );
  const first = seq.steps[0].delayDays;
  const when = first === 0 ? "the first now" : `the first in ${first} day${first === 1 ? "" : "s"}`;
  await addEvent(ctx.tx, lead.id, "sequence", `Enrolled in the sequence “${seq.name}” (${seq.steps.length} emails, ${when}); approved by ${ctx.approver.name}.`, by);
  await audit(
    { actor: userActor(ctx.approver), action: "funnel.enrolled", module: MODULE_ID, target: { type: "lead", id: lead.id }, summary: `${ctx.approver.name} approved sending the sequence "${seq.name}" to the lead "${lead.name}".` },
    ctx.tx,
  );
  return { targetId: enrollment.id, summary: `Enrolled ${lead.name} in “${seq.name}”: ${seq.steps.length} email${seq.steps.length === 1 ? "" : "s"}, ${when}`, after: async () => kickDueEmails() };
}

// ── Rendering and sending ───────────────────────────────────────────────────

export interface RenderedEmail {
  to: string;
  subject: string;
  text: string;
}

export function renderEmail(step: Pick<Step, "subject" | "body">, lead: Pick<Lead, "id" | "name" | "email" | "service">, businessName: string, postalAddress: string): RenderedEmail {
  const vars = { first_name: firstName(lead.name), business_name: businessName, service: lead.service };
  return {
    to: lead.email,
    subject: renderTemplate(step.subject, vars).replace(/[\r\n]+/g, " ").slice(0, 250),
    text: `${renderTemplate(step.body, vars).trim()}\n${emailFooter(businessName, postalAddress, unsubscribeUrl(lead.id))}\n`,
  };
}

/** The first email of a sequence as this lead would get it (for the approval page). */
export async function previewFirstEmail(q: Q, input: EnrollInput): Promise<RenderedEmail | null> {
  const [seq, lead, settings, business] = await Promise.all([getSequence(q, input.sequenceId), getLead(q, input.leadId), getSettings(q), businessProfile()]);
  if (!seq?.steps.length || !lead) return null;
  return renderEmail(seq.steps[0], lead, business.name, settings.postalAddress || "(no postal address set: add it in Leads → Settings)");
}

let running: Promise<number> | null = null;

/**
 * Sends the sequence emails that are due (at most `limit` per run). Each is
 * claimed with one conditional UPDATE first, so two runs at once never send
 * the same email twice. A lead that replied, was contacted, converted or
 * disqualified, or unsubscribed gets nothing more. Returns how many went out.
 */
export async function sendDueEmails(options: { now?: Date; limit?: number } = {}): Promise<number> {
  if (!(await mailConfigured())) return 0;
  const now = options.now ?? new Date();
  const limit = options.limit ?? SEND_BATCH;
  // A claim that never finished (the server stopped mid-send): it may or may not have gone out, so it is never retried by itself.
  await db()
    .update(funnelSends)
    .set({ status: "failed", error: "The server stopped while sending this email, so it may or may not have gone out. Check your sent mail before sending anything again." })
    .where(and(eq(funnelSends.status, "sending"), sql`${funnelSends.claimedAt} < now() - make_interval(mins => ${STALE_SENDING_MINUTES})`));

  const token = randomUUID();
  const claimed = await db().execute<{ id: string }>(sql`
    update funnel_sends s set status = 'sending', claim_token = ${token}, claimed_at = now()
    where s.id in (
      select s2.id from funnel_sends s2
      join funnel_enrollments e on e.id = s2.enrollment_id
      join funnel_sequences q on q.id = e.sequence_id
      join funnel_leads l on l.id = e.lead_id
      where s2.status = 'scheduled' and s2.due_at <= ${now.toISOString()}::timestamptz
        and e.status = 'active' and q.active and l.unsubscribed_at is null
        and l.status in ('new', 'qualified') and l.email <> ''
      order by s2.due_at
      limit ${limit}
      for update of s2 skip locked)
    returning s.id`);
  if (!claimed.length) return 0;

  const [settings, business] = await Promise.all([getSettings(db()), businessProfile()]);
  let sent = 0;
  for (const { id } of claimed) {
    const [row] = await db()
      .select({ send: funnelSends, step: funnelSequenceSteps, enrollment: funnelEnrollments, sequenceName: funnelSequences.name, lead: funnelLeads })
      .from(funnelSends)
      .innerJoin(funnelSequenceSteps, eq(funnelSequenceSteps.id, funnelSends.stepId))
      .innerJoin(funnelEnrollments, eq(funnelEnrollments.id, funnelSends.enrollmentId))
      .innerJoin(funnelSequences, eq(funnelSequences.id, funnelEnrollments.sequenceId))
      .innerJoin(funnelLeads, eq(funnelLeads.id, funnelEnrollments.leadId))
      .where(eq(funnelSends.id, id));
    if (!row) continue;
    if (!settings.postalAddress.trim()) {
      await db().update(funnelSends).set({ status: "failed", error: NO_ADDRESS_MESSAGE }).where(and(eq(funnelSends.id, id), eq(funnelSends.claimToken, token)));
      continue;
    }
    const email = renderEmail(row.step, row.lead, business.name, settings.postalAddress);
    const steps = await db().select({ n: count() }).from(funnelSequenceSteps).where(eq(funnelSequenceSteps.sequenceId, row.enrollment.sequenceId));
    const of = `${row.send.position} of ${steps[0]?.n ?? row.send.position}`;
    try {
      await sendMail(email);
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      await db().update(funnelSends).set({ status: "failed", error: message.slice(0, 500) }).where(and(eq(funnelSends.id, id), eq(funnelSends.claimToken, token)));
      await addEvent(db(), row.lead.id, "email", `Sequence email ${of} of “${row.sequenceName}” could not be sent: ${message.slice(0, 300)}`, "Leads (sent by itself)");
      continue;
    }
    sent += 1;
    await db()
      .update(funnelSends)
      .set({ status: "sent", sentAt: new Date(), toEmail: email.to, subject: email.subject, error: null })
      .where(and(eq(funnelSends.id, id), eq(funnelSends.claimToken, token)));
    await addEvent(db(), row.lead.id, "email", `Sent sequence email ${of} of “${row.sequenceName}”: “${email.subject}”.`, "Leads (sent by itself)");
    // The last email: the enrolment is finished.
    const [left] = await db()
      .select({ n: count() })
      .from(funnelSends)
      .where(and(eq(funnelSends.enrollmentId, row.enrollment.id), inArray(funnelSends.status, ["scheduled", "sending"])));
    if (left.n === 0) {
      await db().update(funnelEnrollments).set({ status: "finished", stoppedAt: new Date() }).where(and(eq(funnelEnrollments.id, row.enrollment.id), eq(funnelEnrollments.status, "active")));
    }
  }
  return sent;
}

/** One run at a time per server process (the claims make overlapping runs safe anyway). */
export function runDueEmails(): Promise<number> {
  running ??= sendDueEmails()
    .catch((error) => {
      console.error("Leads: sending due sequence emails failed:", error);
      return 0;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/**
 * The suite has no job runner (see Customers' reminders): due work runs when
 * people use the suite. This schedules a run after the current response (home
 * page, Leads pages, a form submission, an approval), so nobody waits for it.
 * Outside a request (tests, scripts) it does nothing: call sendDueEmails().
 */
export function kickDueEmails(): void {
  try {
    after(() => runDueEmails().then(() => undefined));
  } catch {
    // Not inside a request: nothing to schedule.
  }
}

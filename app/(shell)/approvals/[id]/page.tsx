import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { ApprovalBadge, ItemBadge, SOURCE_LABEL } from "@/components/approval-status";
import { canDecide, findAction } from "@/lib/approvals/ledger";
import { requireViewer } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { approvalItems, approvals, users } from "@/lib/db/schema";
import { formatDateTime, plural } from "@/lib/format";
import type { Viewer } from "@/lib/modules/contract";
import { permissionsFor } from "@/lib/permissions";
import { businessProfile } from "@/lib/settings";
import { approveAction, declineAction } from "../actions";

export const metadata: Metadata = { title: "Approval" };

const SAMPLE = 5;
/** Records whose WriteAction.review (e.g. a diff) is shown; later records show their preview line only. */
const REVIEWED = 10;

const outcomeSchema = z.object({
  written: z.coerce.number().int().min(0).optional(),
  failed: z.coerce.number().int().min(0).optional(),
  handled: z.coerce.number().int().min(0).optional(),
  again: z.enum(["0", "1"]).optional(),
  declined: z.literal("1").optional(),
});

/** The sentence after a click, built from numbers only (nothing from the URL is shown as text). */
function Outcome({ o }: { o: z.output<typeof outcomeSchema> }) {
  if (o.declined) return <p role="status" className="notice notice-ok">Declined. Nothing from it was written.</p>;
  if (o.written === undefined) return null;
  const parts = [`${plural(o.written, "record")} written`];
  if (o.failed) parts.push(`${o.failed} failed (each record's reason is below; fix the cause, then “Retry failed”)`);
  if (o.handled) parts.push(`${o.handled} already handled before, left alone`);
  return (
    <p role="status" className={`notice ${o.failed ? "notice-error" : "notice-ok"}`} data-testid="approval-outcome">
      {o.again === "1" ? "This was already approved earlier. " : ""}
      {parts.join(", ")}.
    </p>
  );
}

export default async function ApprovalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const viewer = await requireViewer();
  const outcome = outcomeSchema.catch({}).parse(await searchParams);
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const [row] = await db()
    .select({ a: approvals, requesterName: users.name })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.requestedBy))
    .where(eq(approvals.id, id.data));
  if (!row) notFound();
  const a = row.a;
  const held = await permissionsFor(viewer.role);
  const decider = await canDecide(viewer, a);
  if (!decider && a.requestedBy !== viewer.id && !held.has("activity.view")) notFound();

  const items = await db().select().from(approvalItems).where(eq(approvalItems.approvalId, a.id)).orderBy(asc(approvalItems.position));
  const business = await businessProfile();
  const tz = business.timezone;
  const pending = a.status === "pending";
  const failed = items.filter((i) => i.status === "failed").length;
  const reviews = await reviewsFor(a.action, items, viewer, { name: business.name, timezone: tz });
  const decidedBy = a.decidedBy ? (await db().select({ name: users.name }).from(users).where(eq(users.id, a.decidedBy)))[0]?.name : null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link href="/approvals" className="link text-sm">
          ← Approvals
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="h1">{a.title}</h1>
          <ApprovalBadge status={a.status} />
        </div>
        <p className="text-sm text-subtle">
          {SOURCE_LABEL[a.source]}
          {row.requesterName ? ` for ${row.requesterName}` : ""} · {formatDateTime(a.createdAt, tz)} · {plural(a.total, "record")}
          {a.duplicateCount ? ` · ${a.duplicateCount} left out at creation (already in the ledger)` : ""}
        </p>
        {a.summary ? <p className="muted whitespace-pre-line">{a.summary}</p> : null}
      </header>

      <section className="card grid gap-3 text-center sm:grid-cols-4" aria-label="Totals" data-testid="approval-totals">
        <div>
          <p className="text-2xl font-semibold" data-testid="count-applied">{a.appliedCount}</p>
          <p className="text-xs text-subtle">written</p>
        </div>
        <div>
          <p className="text-2xl font-semibold">{items.filter((i) => i.status === "pending" || i.status === "claimed").length}</p>
          <p className="text-xs text-subtle">waiting</p>
        </div>
        <div>
          <p className="text-2xl font-semibold">{failed}</p>
          <p className="text-xs text-subtle">failed</p>
        </div>
        <div>
          <p className="text-2xl font-semibold">{a.skippedCount}</p>
          <p className="text-xs text-subtle">left out</p>
        </div>
      </section>

      <Outcome o={outcome} />

      {decidedBy ? (
        <p className="text-sm">
          {a.status === "declined" ? "Declined" : "Approved"} by {decidedBy} {a.decidedAt ? `on ${formatDateTime(a.decidedAt, tz)}` : ""}.
        </p>
      ) : null}

      {decider && pending ? (
        <section className="card space-y-4" aria-labelledby="decide">
          <h2 id="decide" className="h2">
            Decide
          </h2>
          <p className="muted text-sm">
            Sample of what will be written:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {items.slice(0, SAMPLE).map((i) => (
              <li key={i.id}>{i.preview}</li>
            ))}
            {items.length > SAMPLE ? <li className="text-subtle">…and {items.length - SAMPLE} more, listed below.</li> : null}
          </ul>
          <div className="flex flex-wrap items-start gap-3">
            <ActionForm action={approveAction} submit={items.length === 1 ? "Approve" : `Approve all ${items.length}`} className="space-y-2">
              <input type="hidden" name="approvalId" value={a.id} />
              <input type="hidden" name="mode" value="all" />
            </ActionForm>
            <ActionForm action={declineAction} submit="Decline" submitClassName="btn btn-danger" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="approvalId" value={a.id} />
              <label className="block">
                <span className="label">Reason (optional)</span>
                <input name="reason" maxLength={500} className="input" />
              </label>
            </ActionForm>
          </div>
        </section>
      ) : null}

      {decider && !pending && failed > 0 && a.status !== "declined" ? (
        <section className="card space-y-3">
          <h2 className="h2">Some records failed</h2>
          <p className="muted text-sm">Each failed record shows its reason below. Fix the cause, then retry: records already written are left alone.</p>
          <ActionForm action={approveAction} submit={`Retry ${plural(failed, "failed record")}`}>
            <input type="hidden" name="approvalId" value={a.id} />
            <input type="hidden" name="mode" value="retry" />
          </ActionForm>
        </section>
      ) : null}

      {decider && (a.status === "running") ? (
        <section className="card space-y-3">
          <p className="muted text-sm">Some records are still being written, or the server stopped part-way. Continuing picks up only what is left.</p>
          <ActionForm action={approveAction} submit="Continue writing">
            <input type="hidden" name="approvalId" value={a.id} />
            <input type="hidden" name="mode" value="all" />
          </ActionForm>
        </section>
      ) : null}

      <section className="space-y-3" aria-labelledby="records">
        <h2 id="records" className="h2">
          Records
        </h2>
        {decider && pending && items.length > 1 ? (
          <ActionForm action={approveAction} submit="Approve selected" submitClassName="btn" className="space-y-3">
            <input type="hidden" name="approvalId" value={a.id} />
            <input type="hidden" name="mode" value="selected" />
            <ItemTable items={items} tz={tz} reviews={reviews} selectable />
          </ActionForm>
        ) : (
          <ItemTable items={items} tz={tz} reviews={reviews} />
        )}
      </section>
    </div>
  );
}

/** The action's own review of each record (e.g. a diff), for the first REVIEWED records. A failing review never breaks the page. */
async function reviewsFor(
  actionName: string,
  items: (typeof approvalItems.$inferSelect)[],
  viewer: Viewer,
  business: { name: string; timezone: string },
): Promise<Record<string, ReactNode>> {
  let action;
  try {
    action = findAction(actionName).action;
  } catch {
    return {};
  }
  const review = action.review;
  if (!review) return {};
  const out: Record<string, ReactNode> = {};
  for (const item of items.slice(0, REVIEWED)) {
    const input = action.input.safeParse(item.payload);
    if (!input.success) continue;
    try {
      out[item.id] = await review({ db: db(), viewer, business }, input.data);
    } catch (error) {
      console.error("An approval review failed:", error);
      out[item.id] = <span className="block text-xs text-subtle">The details of this record could not be shown; the line above says what it does.</span>;
    }
  }
  return out;
}

function ItemTable({
  items,
  tz,
  reviews = {},
  selectable = false,
}: {
  items: (typeof approvalItems.$inferSelect)[];
  tz: string;
  reviews?: Record<string, ReactNode>;
  selectable?: boolean;
}) {
  return (
    <div className="card overflow-x-auto p-0 sm:p-0">
      <table className="table" data-testid="approval-items">
        <thead>
          <tr>
            {selectable ? <th className="w-8"><span className="sr-only">Select</span></th> : null}
            <th className="w-10">#</th>
            <th>What it does</th>
            <th className="w-28">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              {selectable ? (
                <td>
                  <input type="checkbox" name="item" value={i.id} defaultChecked aria-label={`Select record ${i.position + 1}`} className="size-4" />
                </td>
              ) : null}
              <td className="text-subtle">{i.position + 1}</td>
              <td>
                <span className="block">{i.preview}</span>
                {reviews[i.id] ? (
                  <div className="mt-2" data-testid="approval-review">
                    {reviews[i.id]}
                  </div>
                ) : null}
                {i.error ? <span className="block text-xs text-danger">Failed: {i.error}</span> : null}
                {i.appliedAt ? (
                  <span className="block text-xs text-subtle" data-testid="item-result">
                    Written {formatDateTime(i.appliedAt, tz)}
                    {resultSummary(i.result) ? `: ${resultSummary(i.result)}` : ""}
                  </span>
                ) : null}
              </td>
              <td>
                <ItemBadge status={i.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The module's one-line result for a written record (WriteAction.apply's `summary`), if it gave one. */
function resultSummary(result: unknown): string {
  const summary = (result as { summary?: unknown } | null)?.summary;
  return typeof summary === "string" ? summary.slice(0, 300) : "";
}

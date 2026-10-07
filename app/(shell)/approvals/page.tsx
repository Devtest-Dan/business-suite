import { desc, eq, inArray, ne, or } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { ApprovalBadge, SOURCE_LABEL } from "@/components/approval-status";
import { requireViewer } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { approvals, users } from "@/lib/db/schema";
import { formatDateTime, plural } from "@/lib/format";
import { decidableApprovals } from "@/lib/inbox";
import { permissionsFor } from "@/lib/permissions";
import { businessProfile } from "@/lib/settings";

export const metadata: Metadata = { title: "Approvals" };

type Row = typeof approvals.$inferSelect & { requesterName?: string | null };

function ApprovalRows({ rows, timezone }: { rows: Row[]; timezone: string }) {
  return (
    <ul className="card divide-y divide-line p-0 sm:p-0">
      {rows.map((a) => (
        <li key={a.id}>
          <Link href={`/approvals/${a.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{a.title}</span>
              <span className="block text-xs text-subtle">
                {SOURCE_LABEL[a.source]}
                {a.requesterName ? ` for ${a.requesterName}` : ""} · {plural(a.total, "record")} · {formatDateTime(a.createdAt, timezone)}
              </span>
            </span>
            <ApprovalBadge status={a.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The shared approvals inbox: everything the AI or an import proposed, one approval per batch. */
export default async function ApprovalsPage() {
  const viewer = await requireViewer();
  const business = await businessProfile();
  const all = (await permissionsFor(viewer.role)).has("approvals.decide");
  const waiting = await decidableApprovals(viewer);
  const recent = await db()
    .select({ a: approvals, requesterName: users.name })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.requestedBy))
    .where(all ? ne(approvals.status, "pending") : or(eq(approvals.requestedBy, viewer.id), eq(approvals.decidedBy, viewer.id)))
    .orderBy(desc(approvals.createdAt))
    .limit(50);
  const names = new Map(
    waiting.length
      ? (await db().select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, waiting.map((w) => w.requestedBy).filter((x): x is string => Boolean(x))))).map((u) => [u.id, u.name])
      : [],
  );
  const recentRows = recent.map((r) => ({ ...r.a, requesterName: r.requesterName })).filter((r) => !waiting.some((w) => w.id === r.id));

  return (
    <div className="space-y-8">
      <header>
        <h1 className="h1">Approvals</h1>
        <p className="muted">Changes the assistant or an import proposed. Nothing in here is written until someone approves it, and a record is never written twice.</p>
      </header>
      <section className="space-y-3" aria-labelledby="waiting">
        <h2 id="waiting" className="h2">
          Waiting for you
        </h2>
        {waiting.length === 0 ? (
          <p className="card muted">Nothing is waiting for your decision.</p>
        ) : (
          <ApprovalRows rows={waiting.map((w) => ({ ...w, requesterName: w.requestedBy ? names.get(w.requestedBy) : null }))} timezone={business.timezone} />
        )}
      </section>
      {recentRows.length ? (
        <section className="space-y-3" aria-labelledby="recent">
          <h2 id="recent" className="h2">
            {all ? "Recent" : "Yours"}
          </h2>
          <ApprovalRows rows={recentRows} timezone={business.timezone} />
        </section>
      ) : null}
    </div>
  );
}

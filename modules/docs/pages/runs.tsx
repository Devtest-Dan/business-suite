import Link from "next/link";
import { z } from "zod";
import { formatDateTime } from "@/lib/format";
import type { ModulePageProps } from "@/lib/modules/contract";
import { getPage } from "../data";
import { listRuns } from "../runs";
import { Crumbs } from "./shared";

const query = z.object({
  page: z.string().uuid().optional().catch(undefined),
  status: z.enum(["open", "completed", "cancelled"]).optional().catch(undefined),
});

const STATUS = { open: "In progress", completed: "Done", cancelled: "Cancelled" } as const;

export async function RunsPage({ ctx, searchParams, basePath }: ModulePageProps) {
  const q = query.parse({ page: searchParams.page, status: searchParams.status });
  const page = q.page ? await getPage(ctx.db, ctx, q.page) : null;
  const runs = await listRuns(ctx.db, ctx, { pageId: page?.id, status: q.status, limit: 200 });
  const tz = ctx.business.timezone;
  const filter = (status?: string) => `${basePath}/runs?${new URLSearchParams({ ...(page ? { page: page.id } : {}), ...(status ? { status } : {}) })}`;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: "Procedure runs" }]} />
        <h1 className="h1">Procedure runs{page ? `: ${page.title}` : ""}</h1>
        <p className="muted">The record of every checklist run: who did each step and when. Open a procedure to start a new run.</p>
      </header>
      <nav aria-label="Filter" className="flex flex-wrap gap-2 text-sm">
        <Link href={filter()} className={`btn ${!q.status ? "btn-primary" : ""}`}>
          All
        </Link>
        {(["open", "completed", "cancelled"] as const).map((s) => (
          <Link key={s} href={filter(s)} className={`btn ${q.status === s ? "btn-primary" : ""}`}>
            {STATUS[s]}
          </Link>
        ))}
      </nav>
      {runs.length === 0 ? (
        <div className="card text-center muted">No runs here yet.</div>
      ) : (
        <div className="card overflow-x-auto p-0 sm:p-0">
          <table className="table" data-testid="runs-table">
            <thead>
              <tr>
                <th>Procedure</th>
                <th>Day</th>
                <th>Progress</th>
                <th className="hidden sm:table-cell">Who</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`${basePath}/runs/${r.id}`} className="link">
                      {r.title}
                    </Link>
                    {r.flagged ? <span className="badge badge-danger ml-2">a check said No</span> : null}
                  </td>
                  <td className="whitespace-nowrap">{r.dueOn}</td>
                  <td className="whitespace-nowrap">
                    <span className={`badge ${r.status === "completed" ? "badge-ok" : r.status === "open" ? "badge-accent" : ""}`}>{STATUS[r.status]}</span>{" "}
                    <span className="text-xs text-subtle">
                      {r.doneCount}/{r.stepCount}
                    </span>
                  </td>
                  <td className="hidden text-sm sm:table-cell">
                    {r.status === "completed" ? `${r.completedByName}, ${formatDateTime(r.completedAt, tz)}` : r.assigneeName ? `For ${r.assigneeName}` : `Started by ${r.startedByName}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

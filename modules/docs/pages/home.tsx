import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { ACCESS_LABEL, P } from "../access";
import { recentPages, spacesFor } from "../data";
import { dueToday, listRuns } from "../runs";
import { KindBadge, SearchBox } from "./shared";

export async function HomePage({ ctx, basePath }: ModulePageProps) {
  const tz = ctx.business.timezone;
  const [spaces, recent, due, mine] = await Promise.all([
    spacesFor(ctx.db, ctx),
    recentPages(ctx.db, ctx, 8),
    dueToday(ctx.db, ctx, tz),
    ctx.can(P.run) ? listRuns(ctx.db, ctx, { status: "open", mine: true, limit: 10 }) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">Docs</h1>
          <p className="muted">How {ctx.business.name} does things: pages, procedures and checklists.</p>
        </div>
        {ctx.can(P.spaces) ? (
          <Link href={`${basePath}/spaces/new`} className="btn btn-primary">
            <Icon name="plus" className="size-4" /> New space
          </Link>
        ) : null}
      </header>

      <SearchBox basePath={basePath} />

      {due.length || mine.length ? (
        <section className="grid gap-4 md:grid-cols-2">
          {due.length ? (
            <div className="card space-y-2" data-testid="due-today">
              <h2 className="h2">Procedures due today</h2>
              <ul className="space-y-2 text-sm">
                {due.map((d) => (
                  <li key={d.pageId} className="flex items-center justify-between gap-2">
                    <Link href={d.runId ? `${basePath}/runs/${d.runId}` : `${basePath}/p/${d.pageId}`} className="link min-w-0 truncate">
                      {d.title}
                    </Link>
                    <span className={`badge ${d.state === "done" ? "badge-ok" : d.state === "open" ? "badge-accent" : "badge-warn"}`}>{d.state}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {mine.length ? (
            <div className="card space-y-2">
              <h2 className="h2">Your open runs</h2>
              <ul className="space-y-2 text-sm">
                {mine.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <Link href={`${basePath}/runs/${r.id}`} className="link min-w-0 truncate">
                      {r.title}
                    </Link>
                    <span className="text-xs text-subtle">
                      {r.doneCount}/{r.stepCount} · {r.dueOn}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-3" aria-labelledby="spaces">
        <h2 id="spaces" className="h2">
          Spaces
        </h2>
        {spaces.length === 0 ? (
          <div className="card text-center">
            <p className="font-medium">No spaces you can open yet.</p>
            <p className="muted">{ctx.can(P.spaces) ? "Make the first one with “New space”." : "When someone adds you to a space, it shows up here."}</p>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="space-list">
            {spaces.map((s) => (
              <li key={s.id}>
                <Link href={`${basePath}/s/${s.id}`} className="card card-link block h-full space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="book" className="size-4 text-accent" />
                    <h3 className="font-semibold">{s.name}</h3>
                    {s.visibility === "private" ? <span className="badge">Private</span> : null}
                  </div>
                  {s.description ? <p className="muted line-clamp-2 text-sm">{s.description}</p> : null}
                  <p className="text-xs text-subtle">{ACCESS_LABEL[s.access]}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {recent.length ? (
        <section className="space-y-3" aria-labelledby="recent">
          <h2 id="recent" className="h2">
            Recently edited
          </h2>
          <ul className="card divide-y divide-line p-0 sm:p-0">
            {recent.map((p) => (
              <li key={p.id}>
                <Link href={`${basePath}/p/${p.id}`} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2 hover:bg-surface-2">
                  <span className="font-medium">{p.title}</span>
                  <KindBadge kind={p.kind} />
                  <span className="text-xs text-subtle">
                    {p.spaceName} · {p.updatedByName}, {formatDateTime(p.updatedAt, tz)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="flex flex-wrap gap-4 text-sm">
        <Link href={`${basePath}/runs`} className="link">
          All procedure runs
        </Link>
        <Link href={`${basePath}/archive`} className="link">
          Archived pages
        </Link>
      </p>
    </div>
  );
}

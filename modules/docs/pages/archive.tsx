import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import type { ModulePageProps } from "@/lib/modules/contract";
import { canEdit } from "../access";
import { archivePageAction } from "../actions";
import { archivedPages, spacesFor } from "../data";
import { Crumbs } from "./shared";

export async function ArchivePage({ ctx, basePath }: ModulePageProps) {
  const spaces = await spacesFor(ctx.db, ctx, { archived: true });
  const pages = await archivedPages(
    ctx.db,
    spaces.map((s) => s.id),
  );
  const editable = new Set(spaces.filter((s) => canEdit(s.access)).map((s) => s.id));
  const archivedSpaces = spaces.filter((s) => s.archivedAt);
  const tz = ctx.business.timezone;
  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: "Archived pages" }]} />
        <h1 className="h1">Archived pages</h1>
        <p className="muted">Archived pages are hidden from their space and from search. Nothing is deleted: bring a page back to use it again.</p>
      </header>
      {archivedSpaces.length ? (
        <section className="card space-y-2">
          <h2 className="h2">Archived spaces</h2>
          <ul className="space-y-1 text-sm">
            {archivedSpaces.map((s) => (
              <li key={s.id}>
                <Link href={`${basePath}/s/${s.id}/settings`} className="link">
                  {s.name}
                </Link>{" "}
                <span className="text-xs text-subtle">archived {formatDateTime(s.archivedAt, tz)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {pages.length === 0 ? (
        <div className="card muted">No archived pages.</div>
      ) : (
        <ul className="card divide-y divide-line p-0 sm:p-0" data-testid="archived-pages">
          {pages.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <Link href={`${basePath}/p/${p.id}`} className="link font-medium">
                  {p.title}
                </Link>
                <p className="text-xs text-subtle">
                  {p.spaceName} · archived {formatDateTime(p.archivedAt, tz)}
                </p>
              </div>
              {editable.has(p.spaceId) ? (
                <form action={archivePageAction.bind(null, p.id, false)}>
                  <button className="btn" type="submit">
                    Bring it back
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

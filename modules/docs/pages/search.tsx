import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import type { ModulePageProps } from "@/lib/modules/contract";
import { searchPages } from "../data";
import { searchForm } from "../schemas";
import { Crumbs, KindBadge, SearchBox } from "./shared";

export async function SearchPage({ ctx, searchParams, basePath }: ModulePageProps) {
  const { q } = searchForm.catch({ q: "" }).parse({ q: typeof searchParams.q === "string" ? searchParams.q : "" });
  const hits = q ? await searchPages(ctx.db, ctx, q, 50) : [];
  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-2">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: "Search" }]} />
        <h1 className="h1">Search docs</h1>
        <SearchBox basePath={basePath} q={q} />
        <p className="hint text-xs text-subtle">Searches titles, text and procedure steps in the spaces you can open. Use quotes for an exact phrase, and -word to leave a word out.</p>
      </header>
      {q ? (
        hits.length === 0 ? (
          <div className="card muted">Nothing matches “{q}”. Try fewer or different words.</div>
        ) : (
          <ul className="space-y-3" data-testid="docs-search-results">
            {hits.map((h) => (
              <li key={h.id}>
                <Link href={`${basePath}/p/${h.id}`} className="card card-link block space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {h.title} <KindBadge kind={h.kind} />
                  </p>
                  {h.snippet ? <p className="muted text-sm">{h.snippet}</p> : null}
                  <p className="text-xs text-subtle">
                    {h.spaceName} · {formatDateTime(h.updatedAt, ctx.business.timezone)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

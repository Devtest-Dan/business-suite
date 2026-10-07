import Link from "next/link";
import { z } from "zod";
import { formatDateTime } from "@/lib/format";
import type { ModulePageProps } from "@/lib/modules/contract";
import { getPage, revisions } from "../data";
import { Crumbs, NotHere } from "./shared";

const VIA: Record<string, string> = { ai: "drafted by the assistant", import: "imported", restore: "brought back", user: "" };

export async function HistoryPage({ ctx, params, basePath }: ModulePageProps) {
  const id = z.string().uuid().safeParse(params.pageId);
  const page = id.success ? await getPage(ctx.db, ctx, id.data) : null;
  if (!page) return <NotHere basePath={basePath} />;
  const rows = await revisions(ctx.db, page.id);
  const tz = ctx.business.timezone;
  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: page.space.name, href: `${basePath}/s/${page.spaceId}` }, { label: page.title, href: `${basePath}/p/${page.id}` }, { label: "History" }]} />
        <h1 className="h1">History of “{page.title}”</h1>
        <p className="muted">Every saved version is kept. Open one to see what changed, or to bring it back (that saves it as a new version; nothing is lost).</p>
      </header>
      <ol className="card divide-y divide-line p-0 sm:p-0" data-testid="history">
        {rows.map((r) => (
          <li key={r.revision}>
            <Link href={`${basePath}/p/${page.id}/history/${r.revision}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2">
              <span className="font-semibold">Version {r.revision}</span>
              {r.revision === page.revision ? <span className="badge badge-ok">Current</span> : null}
              <span className="text-sm">
                {r.editedByName}
                {VIA[r.via] ? ` (${VIA[r.via]})` : ""}, {formatDateTime(r.createdAt, tz)}
              </span>
              {r.note ? <span className="w-full text-sm text-subtle">{r.note}</span> : null}
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

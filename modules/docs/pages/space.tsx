import Link from "next/link";
import { z } from "zod";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { ACCESS_LABEL, canEdit, canManage, P } from "../access";
import { buildTree, getSpace, spacePages } from "../data";
import { scheduleLabel } from "../text";
import { Crumbs, NotHere, Tree } from "./shared";

export async function SpacePage({ ctx, params, basePath }: ModulePageProps) {
  const id = z.string().uuid().safeParse(params.spaceId);
  const space = id.success ? await getSpace(ctx.db, ctx, id.data) : null;
  if (!space) return <NotHere basePath={basePath} what="space" />;
  const rows = await spacePages(ctx.db, space.id);
  const pages = rows.filter((r) => !r.isTemplate);
  const templates = rows.filter((r) => r.isTemplate);
  const procedures = pages.filter((r) => r.kind === "procedure");
  const tree = buildTree(pages);
  const editable = canEdit(space.access) && ctx.can(P.edit);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: space.name }]} />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="h1 flex flex-wrap items-center gap-2">
              {space.name}
              {space.visibility === "private" ? <span className="badge">Private</span> : null}
              {space.archivedAt ? <span className="badge badge-warn">Archived</span> : null}
            </h1>
            {space.description ? <p className="muted">{space.description}</p> : null}
            <p className="text-xs text-subtle">{ACCESS_LABEL[space.access]}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`${basePath}/s/${space.id}/settings`} className="btn">
              <Icon name="users" className="size-4" /> {canManage(space.access) ? "Settings and people" : "Who is here"}
            </Link>
            {ctx.can(P.import) && editable ? (
              <Link href={`${basePath}/s/${space.id}/import`} className="btn">
                <Icon name="upload" className="size-4" /> Import Markdown
              </Link>
            ) : null}
            {editable ? (
              <Link href={`${basePath}/s/${space.id}/new`} className="btn btn-primary">
                <Icon name="plus" className="size-4" /> New page
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="card space-y-3" aria-labelledby="pages">
          <h2 id="pages" className="h2">
            Pages
          </h2>
          {tree.length === 0 ? (
            <p className="muted">{editable ? "No pages yet. Write the first with “New page”." : "No pages yet."}</p>
          ) : (
            <div data-testid="page-tree">
              <Tree nodes={tree} basePath={basePath} />
            </div>
          )}
        </section>

        <div className="space-y-6">
          <section className="card space-y-2" aria-labelledby="procs">
            <h2 id="procs" className="h2">
              Procedures
            </h2>
            {procedures.length === 0 ? (
              <p className="muted text-sm">None yet. A procedure is a page with numbered steps that people run as a checklist.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {procedures.map((p) => (
                  <li key={p.id}>
                    <Link href={`${basePath}/p/${p.id}`} className="link">
                      {p.title}
                    </Link>
                    <span className="block text-xs text-subtle">{scheduleLabel(p.schedule, p.scheduleDay)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card space-y-2" aria-labelledby="templates">
            <h2 id="templates" className="h2">
              Templates
            </h2>
            {templates.length === 0 ? (
              <p className="muted text-sm">None yet. Tick “Use as a template” on a page to offer it when someone starts a new page.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {templates.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`${basePath}/p/${t.id}`} className="link">
                      {t.title}
                    </Link>
                    {editable ? (
                      <Link href={`${basePath}/s/${space.id}/new?template=${t.id}`} className="text-xs link">
                        Use it
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

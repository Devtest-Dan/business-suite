import Link from "next/link";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { canEdit } from "../access";
import { createPageAction } from "../actions";
import { buildTree, getPage, getSpace, pageDirectory, spacePages, templates } from "../data";
import { PageEditor } from "./editor";
import { Crumbs, NotHere, parentOptions } from "./shared";

const query = z.object({
  parent: z.string().uuid().optional().catch(undefined),
  template: z.string().uuid().optional().catch(undefined),
  title: z.string().max(200).optional().catch(undefined),
});

export async function NewPagePage({ ctx, params, searchParams, basePath }: ModulePageProps) {
  const id = z.string().uuid().safeParse(params.spaceId);
  const space = id.success ? await getSpace(ctx.db, ctx, id.data) : null;
  if (!space) return <NotHere basePath={basePath} what="space" />;
  if (!canEdit(space.access)) {
    return (
      <div className="card max-w-xl space-y-2">
        <h1 className="h1">You can read this space but not write in it</h1>
        <p className="muted">Ask one of the space&apos;s managers to make you an editor.</p>
      </div>
    );
  }
  const q = query.parse({ parent: searchParams.parent, template: searchParams.template, title: searchParams.title });
  const [rows, directory, offered, template] = await Promise.all([
    spacePages(ctx.db, space.id),
    pageDirectory(ctx.db, ctx),
    templates(ctx.db, ctx),
    q.template ? getPage(ctx.db, ctx, q.template) : Promise.resolve(null),
  ]);
  const parents = parentOptions(buildTree(rows.filter((r) => !r.isTemplate)));
  const parent = q.parent && parents.some((p) => p.id === q.parent) ? q.parent : "";

  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: space.name, href: `${basePath}/s/${space.id}` }, { label: "New page" }]} />
        <h1 className="h1">New page{template ? ` from “${template.title}”` : ""}</h1>
      </header>

      {offered.length && !template ? (
        <section className="card space-y-2" aria-labelledby="tpl">
          <h2 id="tpl" className="font-semibold">
            Start from a template
          </h2>
          <ul className="flex flex-wrap gap-2">
            {offered.map((t) => (
              <li key={t.id}>
                <Link href={`${basePath}/s/${space.id}/new?template=${t.id}${parent ? `&parent=${parent}` : ""}`} className="btn">
                  {t.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ActionForm action={createPageAction} submit="Save the page" className="card space-y-4">
        <input type="hidden" name="spaceId" value={space.id} />
        <PageEditor
          initial={{
            title: q.title ?? (template ? template.title.replace(/\s*\(template\)\s*$/i, "") : ""),
            body: template?.body ?? "",
            kind: template?.kind ?? "page",
            steps: template?.steps ?? [],
            schedule: template?.schedule ?? "none",
            scheduleDay: template?.scheduleDay ?? null,
          }}
          directory={directory}
          basePath={basePath}
          spaceId={space.id}
          canUpload={false}
        />
        <label className="block">
          <span className="label">Put it under</span>
          <select name="parentId" defaultValue={parent} className="input">
            <option value="">The top of the space</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isTemplate" className="size-4" />
          <span>Use as a template (offered when someone starts a new page)</span>
        </label>
        <p className="hint text-xs text-subtle">You can attach files once the page is saved.</p>
      </ActionForm>
    </div>
  );
}

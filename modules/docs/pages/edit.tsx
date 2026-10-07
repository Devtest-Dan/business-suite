import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { canEdit } from "../access";
import { editPageAction } from "../actions";
import { buildTree, getPage, pageDirectory, spacePages } from "../data";
import { PageEditor } from "./editor";
import { Crumbs, NotHere, parentOptions } from "./shared";

export async function EditPage({ ctx, params, basePath }: ModulePageProps) {
  const id = z.string().uuid().safeParse(params.pageId);
  const page = id.success ? await getPage(ctx.db, ctx, id.data) : null;
  if (!page) return <NotHere basePath={basePath} />;
  if (!canEdit(page.space.access) || page.archivedAt) {
    return (
      <div className="card max-w-xl space-y-2">
        <h1 className="h1">This page cannot be edited</h1>
        <p className="muted">{page.archivedAt ? "It is archived. Bring it back from Archived pages first." : "You can read this space but not change it. Ask one of its managers to make you an editor."}</p>
      </div>
    );
  }
  const [rows, directory] = await Promise.all([spacePages(ctx.db, page.spaceId), pageDirectory(ctx.db, ctx)]);
  const parents = parentOptions(buildTree(rows.filter((r) => !r.isTemplate)), page.id);

  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: page.space.name, href: `${basePath}/s/${page.spaceId}` }, { label: page.title, href: `${basePath}/p/${page.id}` }, { label: "Edit" }]} />
        <h1 className="h1">Edit “{page.title}”</h1>
        <p className="muted text-sm">
          You are editing version {page.revision}. If someone else saves first, your save is stopped (nothing is lost from the box) so you can add your change on top of theirs.
        </p>
      </header>
      <ActionForm action={editPageAction} submit="Save changes" className="card space-y-4">
        <input type="hidden" name="pageId" value={page.id} />
        <input type="hidden" name="baseRevision" value={page.revision} />
        <PageEditor
          initial={{ title: page.title, body: page.body, kind: page.kind, steps: page.steps, schedule: page.schedule, scheduleDay: page.scheduleDay }}
          directory={directory}
          basePath={basePath}
          spaceId={page.spaceId}
          pageId={page.id}
          canUpload={ctx.can("files.upload")}
        />
        <label className="block">
          <span className="label">Put it under</span>
          <select name="parentId" defaultValue={page.parentId ?? ""} className="input">
            <option value="">The top of the space</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isTemplate" defaultChecked={page.isTemplate} className="size-4" />
          <span>Use as a template</span>
        </label>
        <label className="block">
          <span className="label">What changed (optional, shown in the history)</span>
          <input name="note" maxLength={200} className="input" />
        </label>
      </ActionForm>
    </div>
  );
}

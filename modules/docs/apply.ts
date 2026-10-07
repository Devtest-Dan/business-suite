import "server-only";
import { eq } from "drizzle-orm";
import { UserError } from "@/lib/errors";
import type { ApplyContext, ApplyResult, Viewer } from "@/lib/modules/contract";
import { canEdit } from "./access";
import { createPage, defaultSpace, folderChain, getSpace, pageByImportPath, savePage, whoFor } from "./data";
import { docsPages } from "./schema";
import type { CreatePageInput, EditPageInput, ImportPageInput } from "./schemas";

/**
 * The writes the AI, other apps and imports may propose (see manifest
 * `actions`). Each runs inside the approval's transaction, once per record,
 * after a person approved. The person who ASKED must still be allowed to
 * write in the space at that moment; otherwise the record fails with a reason.
 */

function author(ctx: ApplyContext): Viewer {
  return ctx.requestedBy ?? ctx.approver;
}

async function editableSpace(ctx: ApplyContext, spaceId: string | undefined) {
  const by = author(ctx);
  const id = spaceId ?? (await defaultSpace(ctx.tx))?.id;
  if (!id) throw new UserError("There is no team space to put the page in. Make a space in Docs first, then retry.");
  const space = await getSpace(ctx.tx, await whoFor(by), id);
  if (!space) throw new UserError(`${by.name} cannot open that space (it is private or was removed), so nothing was written.`);
  if (!canEdit(space.access)) throw new UserError(`${by.name} can read the space “${space.name}” but not write in it, so nothing was written. Make them an editor of the space, then retry.`);
  return space;
}

const via = (ctx: ApplyContext) => (ctx.source === "ai" ? "ai" : ctx.source === "import" ? "import" : "user") as "ai" | "import" | "user";

export async function applyCreatePage(ctx: ApplyContext, input: CreatePageInput): Promise<ApplyResult> {
  const space = await editableSpace(ctx, input.spaceId);
  const page = await createPage(
    ctx.tx,
    {
      spaceId: space.id,
      parentId: input.parentId ?? null,
      title: input.title,
      body: input.body,
      kind: input.kind,
      steps: input.steps,
      schedule: "none",
      scheduleDay: null,
      isTemplate: false,
      note: input.note || (ctx.source === "ai" ? "Drafted by the assistant" : ""),
      sourceKey: `${ctx.approvalId}:${ctx.dedupeKey}`,
    },
    author(ctx),
    via(ctx),
  );
  return { targetId: page.id, summary: `Wrote “${page.title}” in ${space.name}` };
}

export async function applyEditPage(ctx: ApplyContext, input: EditPageInput): Promise<ApplyResult> {
  const [current] = await ctx.tx.select({ spaceId: docsPages.spaceId, archivedAt: docsPages.archivedAt }).from(docsPages).where(eq(docsPages.id, input.pageId));
  if (!current) throw new UserError("The page no longer exists, so the change was not written.");
  if (current.archivedAt) throw new UserError("The page was archived after this change was drafted. Bring it back first, then retry.");
  await editableSpace(ctx, current.spaceId);
  const { page, changed } = await savePage(
    ctx.tx,
    input.pageId,
    input.baseRevision,
    { title: input.title, body: input.body, steps: input.steps, note: input.note || (ctx.source === "ai" ? "Change drafted by the assistant" : "") },
    author(ctx),
    via(ctx),
  );
  return { targetId: page.id, summary: changed ? `Changed “${page.title}” (now version ${page.revision})` : `“${page.title}” already said this; nothing changed` };
}

export async function applyImportPage(ctx: ApplyContext, input: ImportPageInput): Promise<ApplyResult> {
  const space = await editableSpace(ctx, input.spaceId);
  const by = author(ctx);
  const path = input.path.toLowerCase();
  const existing = await pageByImportPath(ctx.tx, space.id, path);
  if (existing) {
    if (existing.archivedAt) await ctx.tx.update(docsPages).set({ archivedAt: null }).where(eq(docsPages.id, existing.id));
    const { page, changed } = await savePage(
      ctx.tx,
      existing.id,
      existing.revision,
      { title: input.title, body: input.body, kind: input.kind, steps: input.steps, schedule: input.schedule, note: `Imported again from ${input.path}` },
      by,
      "import",
    );
    return { targetId: page.id, summary: changed ? `Updated “${page.title}” from ${input.path}` : `“${page.title}” already matched ${input.path}` };
  }
  const parentId = await folderChain(ctx.tx, space.id, input.folders, by);
  const page = await createPage(
    ctx.tx,
    {
      spaceId: space.id,
      parentId,
      title: input.title,
      body: input.body,
      kind: input.kind,
      steps: input.steps,
      schedule: input.schedule,
      scheduleDay: null,
      isTemplate: false,
      note: `Imported from ${input.path}`,
      importPath: path,
      sourceKey: `${ctx.approvalId}:${ctx.dedupeKey}`,
    },
    by,
    "import",
  );
  return { targetId: page.id, summary: `Imported “${page.title}” into ${space.name}` };
}

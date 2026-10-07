"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { propose } from "@/lib/approvals/ledger";
import { UserError } from "@/lib/errors";
import { formAction, type FormState } from "@/lib/forms";
import { requireModule } from "@/lib/modules/server";
import { canEdit, MODULE_ID, P } from "./access";
import {
  addAttachment,
  createPage,
  createSpace,
  getPage,
  getSpace,
  importKey,
  removeAttachment,
  removeMember,
  restoreRevision,
  savePage,
  setMember,
  setPageArchived,
  setSpaceArchived,
  updateSpace,
} from "./data";
import { cancelRun, completeStep, finishRun, getRun, startRun, undoStep } from "./runs";
import {
  editPageForm,
  importForm,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_FILES,
  memberForm,
  newPageForm,
  restoreForm,
  runIdForm,
  spaceForm,
  spaceSettingsForm,
  startRunForm,
  stepDoneForm,
} from "./schemas";
import { parseMarkdownFile } from "./text";

const id = z.string().uuid();
const base = `/m/${MODULE_ID}`;

async function readableSpace(ctx: Awaited<ReturnType<typeof requireModule>>, spaceId: string) {
  const space = await getSpace(ctx.db, ctx, spaceId);
  if (!space) throw new UserError("That space does not exist, or you are not a member of it.");
  return space;
}

async function readablePage(ctx: Awaited<ReturnType<typeof requireModule>>, pageId: string) {
  const page = await getPage(ctx.db, ctx, id.parse(pageId));
  if (!page) throw new UserError("That page does not exist, or it is in a space you cannot open.");
  return page;
}

// ── Spaces ───────────────────────────────────────────────────────────────────

export const createSpaceAction = formAction(spaceForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.spaces);
  const space = await ctx.db.transaction((tx) => createSpace(tx, input, ctx.viewer));
  redirect(`${base}/s/${space.id}`);
});

export const updateSpaceAction = formAction(spaceSettingsForm, async ({ spaceId, ...input }) => {
  const ctx = await requireModule(MODULE_ID, P.access);
  await updateSpace(ctx, await readableSpace(ctx, spaceId), input);
  refresh();
  return { ok: "Saved the space." };
});

export async function archiveSpaceAction(spaceId: string, archived: boolean): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.access);
  await setSpaceArchived(ctx, await readableSpace(ctx, id.parse(spaceId)), z.boolean().parse(archived));
  refresh();
}

export const setMemberAction = formAction(memberForm, async ({ spaceId, userId, role }) => {
  const ctx = await requireModule(MODULE_ID, P.access);
  await setMember(ctx, await readableSpace(ctx, spaceId), userId, role);
  refresh();
  return { ok: "Saved who is in the space." };
});

export async function removeMemberAction(spaceId: string, userId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.access);
  await removeMember(ctx, await readableSpace(ctx, id.parse(spaceId)), id.parse(userId));
  refresh();
}

// ── Pages ────────────────────────────────────────────────────────────────────

export const createPageAction = formAction(newPageForm, async ({ spaceId, ...input }) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const space = await readableSpace(ctx, spaceId);
  if (!canEdit(space.access)) throw new UserError("You can read this space but not add pages to it. Ask one of its managers to make you an editor.");
  const page = await ctx.db.transaction((tx) => createPage(tx, { ...input, spaceId }, ctx.viewer));
  redirect(`${base}/p/${page.id}`);
});

export const editPageAction = formAction(editPageForm, async ({ pageId, baseRevision, ...change }) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const page = await readablePage(ctx, pageId);
  if (!canEdit(page.space.access)) throw new UserError("You can read this space but not change it. Ask one of its managers to make you an editor.");
  if (page.archivedAt) throw new UserError("This page is archived. Bring it back before editing it.");
  await ctx.db.transaction((tx) => savePage(tx, page.id, baseRevision, { ...change, parentId: change.parentId ?? null }, ctx.viewer));
  redirect(`${base}/p/${page.id}`);
});

export async function archivePageAction(pageId: string, archived: boolean): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const page = await readablePage(ctx, pageId);
  await setPageArchived(ctx, page, z.boolean().parse(archived));
  if (archived) redirect(`${base}/s/${page.spaceId}`);
  refresh();
}

export const restoreRevisionAction = formAction(restoreForm, async ({ pageId, revision }) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const page = await readablePage(ctx, pageId);
  await restoreRevision(ctx, page, revision);
  redirect(`${base}/p/${page.id}`);
});

/** Called by the page after the browser uploaded a file to /api/files. Returns the Markdown to link it. */
export async function attachFileAction(pageId: string, fileId: string): Promise<FormState> {
  try {
    const ctx = await requireModule(MODULE_ID, P.edit);
    const page = await readablePage(ctx, pageId);
    const row = await addAttachment(ctx, page, id.parse(fileId));
    refresh();
    if (!row) return { ok: "That file is already attached." };
    const link = row.mime.startsWith("image/") && row.mime !== "image/svg+xml" ? `![${row.name}](/api/files/${row.fileId})` : `[${row.name}](/api/files/${row.fileId})`;
    return { ok: `Attached “${row.name}”.`, data: { markdown: link } };
  } catch (error) {
    return { error: error instanceof UserError ? error.message : "The file could not be attached. Try again." };
  }
}

export async function removeAttachmentAction(pageId: string, attachmentId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.edit);
  await removeAttachment(ctx, await readablePage(ctx, pageId), id.parse(attachmentId));
  refresh();
}

/**
 * Markdown import: every file becomes one record of ONE approval. Nothing is
 * written until someone approves; the same file (same path and text) is never
 * imported twice, and a changed file updates the page it made last time.
 */
export const importMarkdownAction = formAction(importForm, async ({ spaceId }, formData) => {
  const ctx = await requireModule(MODULE_ID, P.import);
  const space = await readableSpace(ctx, spaceId);
  if (!canEdit(space.access)) throw new UserError("You can read this space but not add pages to it.");
  const uploads = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (uploads.length === 0) throw new UserError("Choose at least one Markdown file (.md).");
  if (uploads.length > MAX_IMPORT_FILES) throw new UserError(`Import at most ${MAX_IMPORT_FILES} files at a time. Split them into smaller batches.`);
  const paths = formData.getAll("paths").map(String);
  const items = [];
  const skipped: string[] = [];
  for (const [i, file] of uploads.entries()) {
    const path = (paths[i] || file.name).replace(/\\/g, "/").slice(0, 500);
    if (!/\.(md|markdown|txt)$/i.test(path)) {
      skipped.push(`${path} (not a Markdown file)`);
      continue;
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      skipped.push(`${path} (larger than 200 KB)`);
      continue;
    }
    const parsed = parseMarkdownFile(path, await file.text());
    items.push({ spaceId: space.id, path, ...parsed });
  }
  if (items.length === 0) throw new UserError(`None of the files could be used: ${skipped.slice(0, 3).join("; ")}.`);
  const result = await propose({
    action: `${MODULE_ID}.import_page`,
    source: "import",
    requestedBy: ctx.viewer,
    title: `Import ${items.length} Markdown file${items.length === 1 ? "" : "s"} into ${space.name}`,
    note: `${ctx.viewer.name} chose ${uploads.length} file(s).${skipped.length ? ` Left out: ${skipped.slice(0, 5).join("; ")}${skipped.length > 5 ? "…" : ""}.` : ""}`,
    items,
    keys: items.map((it) => importKey(space.id, it.path, it)),
  });
  if (!result.approvalId) {
    const why = result.invalid.length
      ? `No file could be used. First problem: ${items[result.invalid[0].index]?.path ?? "a file"}: ${result.invalid[0].error}`
      : "Every file was already imported with the same text, so there is nothing new to approve.";
    throw new UserError(why);
  }
  redirect(`/approvals/${result.approvalId}`);
});

// ── Runs ─────────────────────────────────────────────────────────────────────

export const startRunAction = formAction(startRunForm, async ({ pageId, assignedTo, dueOn }) => {
  const ctx = await requireModule(MODULE_ID, P.run);
  const page = await readablePage(ctx, pageId);
  const run = await startRun(ctx, page, { assignedTo, dueOn });
  redirect(`${base}/runs/${run.id}`);
});

async function readableRun(ctx: Awaited<ReturnType<typeof requireModule>>, runId: string) {
  const run = await getRun(ctx.db, ctx, id.parse(runId));
  if (!run) throw new UserError("That run does not exist, or it is in a space you cannot open.");
  return run;
}

export const completeStepAction = formAction(stepDoneForm, async ({ runId, position, answer }) => {
  const ctx = await requireModule(MODULE_ID, P.run);
  await completeStep(ctx, await readableRun(ctx, runId), position, answer);
  refresh();
  return { ok: `Step ${position + 1} done.` };
});

export async function undoStepAction(runId: string, position: number): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.run);
  await undoStep(ctx, await readableRun(ctx, runId), z.number().int().min(0).parse(position));
  refresh();
}

export const finishRunAction = formAction(runIdForm, async ({ runId }) => {
  const ctx = await requireModule(MODULE_ID, P.run);
  await finishRun(ctx, await readableRun(ctx, runId));
  refresh();
  return { ok: "Finished. The run is recorded with who did each step and when." };
});

export async function cancelRunAction(runId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.run);
  await cancelRun(ctx, await readableRun(ctx, runId));
  refresh();
}

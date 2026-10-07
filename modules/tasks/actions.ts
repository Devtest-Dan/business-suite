"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { propose } from "@/lib/approvals/ledger";
import { UserError, messageFor } from "@/lib/errors";
import { formAction } from "@/lib/forms";
import type { ModuleContext } from "@/lib/modules/contract";
import { requireModule } from "@/lib/modules/server";
import { MAX_FILE_BYTES } from "@/lib/storage";
import {
  addAttachment,
  addChecklistItem,
  addComment,
  addProjectMember,
  checklistItemTask,
  createProject,
  createTask,
  deleteChecklistItem,
  deleteProject,
  deleteTask,
  getProject,
  moveTask,
  projectAudience,
  projectFromTemplate,
  removeAttachment,
  removeProjectMember,
  saveAsTemplate,
  setChecklistItem,
  setProjectArchived,
  setTaskStatus,
  setWatching,
  updateProject,
  updateTask,
  visibleTask,
} from "./data";
import { MODULE_ID, P } from "./constants";
import { ahlDedupeKey, ahlRecordsToInputs, csvToTaskRecords, parseAhlExport } from "./imports";
import {
  ahlImportForm,
  checklistForm,
  commentForm,
  csvImportForm,
  deleteProjectForm,
  fromTemplateForm,
  idSchema,
  memberForm,
  projectForm,
  projectSettingsForm,
  quickTaskForm,
  statusSchema,
  taskEditForm,
} from "./schemas";

const base = `/m/${MODULE_ID}`;

async function seeTask(ctx: ModuleContext, taskId: string) {
  const task = await visibleTask(ctx, idSchema.parse(taskId));
  if (!task) throw new UserError("That task does not exist, or you cannot see its project.");
  return task;
}

async function seeProject(ctx: ModuleContext, projectId: string) {
  const project = await getProject(ctx, idSchema.parse(projectId));
  if (!project) throw new UserError("That project does not exist, or you cannot see it.");
  return project;
}

// ── Projects ─────────────────────────────────────────────────────────────────

export const createProjectAction = formAction(projectForm.extend({ template: z.string().optional() }), async (input) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  const project = await createProject(ctx.db, { ...input, isTemplate: input.template === "1" }, ctx.viewer);
  redirect(`${base}/p/${project.id}`);
});

export const updateProjectAction = formAction(projectSettingsForm, async ({ projectId, ...input }) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  await seeProject(ctx, projectId);
  await updateProject(ctx, projectId, input);
  refresh();
  return { ok: "Saved." };
});

export async function archiveProjectAction(projectId: string, archived: boolean): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.manage);
  await seeProject(ctx, projectId);
  await setProjectArchived(ctx, projectId, z.boolean().parse(archived));
  refresh();
}

export const deleteProjectAction = formAction(deleteProjectForm, async ({ projectId }) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  const project = await seeProject(ctx, projectId);
  await deleteProject(ctx, projectId);
  redirect(project.isTemplate ? `${base}/templates` : `${base}/projects`);
});

export const addMemberAction = formAction(memberForm, async ({ projectId, userId }) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  await seeProject(ctx, projectId);
  await addProjectMember(ctx, projectId, userId);
  refresh();
  return { ok: "Added." };
});

export async function removeMemberAction(projectId: string, userId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.manage);
  await seeProject(ctx, projectId);
  await removeProjectMember(ctx, projectId, idSchema.parse(userId));
  refresh();
}

export const fromTemplateAction = formAction(fromTemplateForm, async ({ templateId, name, startOn }) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  await seeProject(ctx, templateId);
  const project = await projectFromTemplate(ctx, templateId, name, startOn);
  redirect(`${base}/p/${project.id}`);
});

export const saveAsTemplateAction = formAction(z.object({ projectId: idSchema, name: projectForm.shape.name }), async ({ projectId, name }) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  await seeProject(ctx, projectId);
  const template = await saveAsTemplate(ctx, projectId, name);
  redirect(`${base}/p/${template.id}`);
});

// ── Tasks ────────────────────────────────────────────────────────────────────

export const quickAddTask = formAction(quickTaskForm, async ({ projectId, title, dueOn, assigneeId }) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const project = await seeProject(ctx, projectId);
  if (project.archived) throw new UserError("This project is archived. Bring it back in its settings to add tasks.");
  if (assigneeId && !(await projectAudience(projectId)).some((p) => p.id === assigneeId)) {
    throw new UserError("That person cannot see this project. Add them to it first, or choose someone else.");
  }
  const { notifyAssigned } = await ctx.db.transaction((tx) =>
    createTask(tx, { projectId, title, dueOn: project.isTemplate ? null : dueOn, assigneeIds: assigneeId ? [assigneeId] : [] }, ctx.viewer),
  );
  await notifyAssigned();
  refresh();
  return { ok: `Added “${title}”.` };
});

export const saveTaskAction = formAction(taskEditForm, async ({ taskId, ...changes }, formData) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const task = await seeTask(ctx, taskId);
  const assigneeIds = formData
    .getAll("assigneeIds")
    .filter((v): v is string => typeof v === "string" && v !== "")
    .map((v) => idSchema.parse(v));
  const audience = new Set((await projectAudience(task.projectId)).map((p) => p.id));
  if (assigneeIds.some((id) => !audience.has(id))) throw new UserError("One of the people chosen cannot see this project. Add them to the project first.");
  if (assigneeIds.length > 10) throw new UserError("Assign at most 10 people.");
  await updateTask(ctx, taskId, { ...changes, assigneeIds, dueOn: task.isTemplate ? null : changes.dueOn, dueOffsetDays: task.isTemplate ? changes.dueOffsetDays : null });
  refresh();
  return { ok: "Saved." };
});

export async function setStatusAction(taskId: string, status: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.edit);
  await seeTask(ctx, taskId);
  const next = statusSchema.parse(status);
  const { after } = await ctx.db.transaction((tx) => setTaskStatus(tx, taskId, next, ctx.viewer, { timezone: ctx.business.timezone }));
  await after();
  refresh();
}

/** From the board's drag and drop. Returns an error message instead of throwing, so the board can put the card back. */
export async function moveTaskAction(taskId: string, status: string, index: number): Promise<{ error?: string }> {
  try {
    const ctx = await requireModule(MODULE_ID, P.edit);
    await seeTask(ctx, taskId);
    await moveTask(ctx, taskId, statusSchema.parse(status), z.number().int().min(0).max(10_000).parse(index));
    refresh();
    return {};
  } catch (error) {
    return { error: messageFor(error) };
  }
}

export async function deleteTaskAction(taskId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.edit);
  await seeTask(ctx, taskId);
  const { projectId } = await deleteTask(ctx, taskId);
  redirect(`${base}/p/${projectId}`);
}

export async function watchAction(taskId: string, watch: boolean): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.access);
  await seeTask(ctx, taskId);
  await setWatching(ctx, taskId, z.boolean().parse(watch));
  refresh();
}

export const commentAction = formAction(commentForm, async ({ taskId, body }) => {
  const ctx = await requireModule(MODULE_ID, P.comment);
  await seeTask(ctx, taskId);
  await addComment(ctx, taskId, body);
  refresh();
  return { ok: "Comment added." };
});

export const checklistAddAction = formAction(checklistForm, async ({ taskId, text }) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  await seeTask(ctx, taskId);
  await addChecklistItem(ctx, taskId, text);
  refresh();
  return { ok: "Added to the checklist." };
});

export async function checklistToggleAction(itemId: string, done: boolean): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const taskId = await checklistItemTask(ctx, idSchema.parse(itemId));
  if (!taskId) throw new UserError("That checklist item no longer exists.");
  await seeTask(ctx, taskId);
  await setChecklistItem(ctx, itemId, z.boolean().parse(done));
  refresh();
}

export async function checklistDeleteAction(itemId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const taskId = await checklistItemTask(ctx, idSchema.parse(itemId));
  if (!taskId) return;
  await seeTask(ctx, taskId);
  await deleteChecklistItem(ctx, itemId);
  refresh();
}

export const attachAction = formAction(z.object({ taskId: idSchema }), async ({ taskId }, formData) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  await seeTask(ctx, taskId);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new UserError("Choose a file to attach first.");
  if (file.size > MAX_FILE_BYTES) throw new UserError("The file is larger than 10 MB. Make it smaller, or share a link to it in a comment.");
  await addAttachment(ctx, taskId, { name: file.name, mime: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) });
  refresh();
  return { ok: `Attached “${file.name}”.` };
});

export async function removeAttachmentAction(taskId: string, fileId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.edit);
  await seeTask(ctx, taskId);
  await removeAttachment(ctx, taskId, idSchema.parse(fileId));
  refresh();
}

// ── Imports: one batch approval each ─────────────────────────────────────────

export const importCsvAction = formAction(csvImportForm, async ({ projectId, csv }) => {
  const ctx = await requireModule(MODULE_ID, P.import);
  const project = await seeProject(ctx, projectId);
  if (project.isTemplate || project.archived) throw new UserError("Choose an open project (not a template or an archived project).");
  const { records, keys } = csvToTaskRecords(csv, projectId);
  const result = await propose({
    action: `${MODULE_ID}.create_task`,
    source: "import",
    requestedBy: ctx.viewer,
    title: `Import ${records.length} task${records.length === 1 ? "" : "s"} into “${project.name}”`,
    note: `${ctx.viewer.name} pasted a CSV with ${records.length} row${records.length === 1 ? "" : "s"}.`,
    items: records,
    keys,
  });
  if (!result.approvalId) {
    throw new UserError(
      result.invalid.length
        ? `No row could be used. First problem: row ${result.invalid[0].index + 2}: ${result.invalid[0].error}`
        : "Every row is already in the ledger from an earlier import, so there is nothing new to approve.",
    );
  }
  redirect(`/approvals/${result.approvalId}`);
});

/**
 * The AHL "Tasks" export (v1 JSON): the whole file is ONE approval, each task
 * keyed by its externalId (and updatedAt), so importing it again adds nothing.
 */
export const importAhlAction = formAction(ahlImportForm, async (input, formData) => {
  const ctx = await requireModule(MODULE_ID, P.import);
  let text = input.json;
  const file = formData.get("file");
  if (!text && file instanceof File && file.size > 0) {
    if (file.size > 2_000_000) throw new UserError("The file is too large for one import.");
    text = await file.text();
  }
  if (!text.trim()) throw new UserError("Paste the contents of the exported file, or choose the file.");
  const parsed = parseAhlExport(text);
  if (parsed.tasks.length === 0) throw new UserError(`No task in the file could be read. First problem: task ${parsed.invalid[0].index + 1}: ${parsed.invalid[0].error}`);

  let projectId: string;
  let projectName: string;
  if (input.projectId === "new") {
    if (!ctx.can(P.manage)) throw new UserError("You can import into an existing project, but only someone who manages projects can create one. Choose a project.");
    const name = input.newProjectName?.trim() || (parsed.businessName ? `Steps for ${parsed.businessName}` : "Imported steps");
    const project = await createProject(ctx.db, { name, description: "Tasks imported from a Tasks export file.", visibility: "team" }, ctx.viewer);
    projectId = project.id;
    projectName = project.name;
  } else {
    const project = await seeProject(ctx, input.projectId);
    if (project.isTemplate || project.archived) throw new UserError("Choose an open project (not a template or an archived project).");
    projectId = project.id;
    projectName = project.name;
  }
  const audience = new Set((await projectAudience(projectId)).map((p) => p.id));
  for (const id of [input.ownerId, input.internId]) {
    if (id && !audience.has(id) && input.projectId !== "new") throw new UserError("One of the people chosen cannot see that project. Add them to it first, or choose someone else.");
  }
  const items = ahlRecordsToInputs(parsed.tasks, { projectId, ownerId: input.ownerId ?? null, internId: input.internId ?? null });
  const result = await propose({
    action: `${MODULE_ID}.import_ahl_task`,
    source: "import",
    requestedBy: ctx.viewer,
    title: `Import ${items.length} task${items.length === 1 ? "" : "s"} from a Tasks export into “${projectName}”`,
    note: [
      `${ctx.viewer.name} imported a Tasks export${parsed.businessName ? ` for ${parsed.businessName}` : ""}.`,
      parsed.invalid.length ? `${parsed.invalid.length} task(s) in the file could not be read and were left out (first: ${parsed.invalid[0].error}).` : "",
    ]
      .filter(Boolean)
      .join(" "),
    items,
    keys: items.map(ahlDedupeKey),
  });
  if (!result.approvalId) {
    // Nothing to approve: do not leave behind the empty project made for it.
    if (input.projectId === "new") await deleteProject(ctx, projectId);
    throw new UserError(
      result.invalid.length
        ? `No task could be used. First problem: task ${result.invalid[0].index + 1}: ${result.invalid[0].error}`
        : "Every task in this file was already imported (and has not changed since), so there is nothing new to approve.",
    );
  }
  redirect(`/approvals/${result.approvalId}`);
});

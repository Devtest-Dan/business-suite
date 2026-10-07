import { z } from "zod";
import { AHL_FORMAT, AHL_VERSION, PROJECT_VISIBILITIES, TASK_PRIORITIES, TASK_RECURRENCES, TASK_STATUSES } from "./constants";
import { isIsoDate, isSafeSuitePath, MAX_LABEL_LENGTH, MAX_LABELS, parseLabels } from "./logic";

// ── Pieces ────────────────────────────────────────────────────────────────────

const title = z.string().trim().min(1, "Give the task a title.").max(200, "Keep the title under 200 characters.");
const description = z.string().trim().max(10_000, "Keep the description under 10,000 characters.");
const isoDate = z.string().trim().refine(isIsoDate, "Use a real date written as YYYY-MM-DD.");
/** An empty form field means "no date". */
const optionalFormDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .refine((v) => v === null || isIsoDate(v), "Use a real date written as YYYY-MM-DD.");
const label = z.string().trim().min(1).max(MAX_LABEL_LENGTH, `Keep each label under ${MAX_LABEL_LENGTH} characters.`);

export const statusSchema = z.enum(TASK_STATUSES);
export const prioritySchema = z.enum(TASK_PRIORITIES);
export const recurrenceSchema = z.enum(TASK_RECURRENCES);
export const idSchema = z.string().uuid();

// ── Write actions (AI tools, imports and other apps propose these) ───────────

/**
 * One new task. `project` is a project's name or id; `assignees` are people's
 * emails or full names. Both are looked up when the task is written.
 */
export const taskInput = z.object({
  project: z.string().trim().min(1, "Say which project the task goes in (its name or id).").max(200),
  /** Another app filing its own tasks (e.g. Customers' "Customer follow-ups") may ask for the team project to be made when missing. */
  createProjectIfMissing: z.boolean().default(false),
  title,
  description: description.default(""),
  status: statusSchema.default("todo"),
  priority: prioritySchema.default("normal"),
  dueOn: isoDate.nullable().default(null),
  assignees: z.array(z.string().trim().min(1).max(200)).max(10, "Assign at most 10 people.").default([]),
  labels: z.array(label).max(MAX_LABELS, `Use at most ${MAX_LABELS} labels.`).default([]),
  checklist: z.array(z.string().trim().min(1).max(300)).max(50, "Keep the checklist to 50 items.").default([]),
  recurrence: recurrenceSchema.default("none"),
  /** Where the task came from, shown on it ("From chat: #general"). */
  sourceLabel: z.string().trim().max(200).optional(),
  /** A link back inside the suite (e.g. "/m/chat/…"); never another site. */
  sourceUrl: z.string().trim().refine(isSafeSuitePath, "The source link must be a path inside the suite, starting with /.").optional(),
});
export type TaskInput = z.output<typeof taskInput>;

/** Change one task's status. `title`, when given, must match the task (it is what the approver reads). */
export const statusInput = z.object({
  taskId: idSchema,
  status: statusSchema,
  title: z.string().trim().max(200).optional(),
});
export type StatusInput = z.output<typeof statusInput>;

/** One task from the AHL "Tasks" export (v1), with the project and person already chosen by the importer. */
export const ahlTaskInput = z.object({
  projectId: idSchema,
  externalId: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1, "The task has no title.").max(200),
  detail: z.string().trim().max(10_000).default(""),
  status: z.enum(["todo", "doing", "done"]),
  assigneeId: idSchema.nullable().default(null),
  dueOn: isoDate.nullable().default(null),
  sourceLabel: z.string().trim().max(200).default(""),
  externalUpdatedAt: z.string().datetime({ offset: true }),
});
export type AhlTaskInput = z.output<typeof ahlTaskInput>;

// ── The AHL export file (docs/TASK_EXPORT_FORMAT.md in the AHL repo) ─────────

/** Unknown fields are ignored (z.object strips them), as the format asks. */
export const ahlTaskRecord = z.object({
  externalId: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(10_000).nullish(),
  status: z.enum(["todo", "doing", "done"]).catch("todo"),
  assignee: z.enum(["owner", "intern"]).catch("owner"),
  dueOn: z
    .string()
    .nullish()
    .transform((v) => (v && isIsoDate(v) ? v : null)),
  source: z
    .object({ kind: z.string().nullish(), label: z.string().nullish(), ref: z.string().nullish(), position: z.number().nullish() })
    .nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type AhlTaskRecord = z.output<typeof ahlTaskRecord>;

export const ahlExportHeader = z.object({
  format: z.literal(AHL_FORMAT, { error: `This is not a Tasks export: its "format" must be "${AHL_FORMAT}".` }),
  version: z.literal(AHL_VERSION, { error: `This file is a version this suite cannot read yet (it reads version ${AHL_VERSION}). Update the suite, or export again in version ${AHL_VERSION}.` }),
  exportedAt: z.string().nullish(),
  business: z.object({ name: z.string().nullish() }).nullish(),
  tasks: z.array(z.unknown()).max(1000, "The file has more than 1,000 tasks. Export fewer at a time."),
});

// ── Forms ─────────────────────────────────────────────────────────────────────

export const projectForm = z.object({
  name: z.string().trim().min(1, "Give the project a name.").max(120, "Keep the name under 120 characters."),
  description: z.string().trim().max(2000, "Keep the description under 2,000 characters.").default(""),
  visibility: z.enum(PROJECT_VISIBILITIES).default("team"),
});

export const quickTaskForm = z.object({
  projectId: idSchema,
  title,
  dueOn: optionalFormDate,
  assigneeId: z
    .string()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v === null || idSchema.safeParse(v).success, "Choose a person from the list."),
});

export const taskEditForm = z.object({
  taskId: idSchema,
  title,
  description: description.default(""),
  priority: prioritySchema,
  dueOn: optionalFormDate,
  dueOffsetDays: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .refine((v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 3650), "Days after start must be a whole number from 0 to 3650."),
  labels: z
    .string()
    .optional()
    .transform((v) => parseLabels(v ?? "")),
  recurrence: recurrenceSchema,
});

export const commentForm = z.object({
  taskId: idSchema,
  body: z.string().trim().min(1, "Write the comment first.").max(5000, "Keep the comment under 5,000 characters."),
});

export const checklistForm = z.object({
  taskId: idSchema,
  text: z.string().trim().min(1, "Write the checklist item first.").max(300, "Keep a checklist item under 300 characters."),
});

export const memberForm = z.object({
  projectId: idSchema,
  userId: idSchema,
});

export const projectSettingsForm = projectForm.extend({ projectId: idSchema });

export const deleteProjectForm = z.object({
  projectId: idSchema,
  confirm: z.literal("on", { error: "Tick the box to confirm that the project and its tasks are deleted for good." }),
});

export const fromTemplateForm = z.object({
  templateId: idSchema,
  name: projectForm.shape.name,
  startOn: isoDate,
});

export const csvImportForm = z.object({
  projectId: idSchema,
  csv: z.string().trim().min(1, "Paste the CSV text (a header row, then one task per row).").max(500_000, "That is too much text for one import. Split it into smaller batches."),
});

export const ahlImportForm = z.object({
  projectId: z.union([idSchema, z.literal("new")], { error: "Choose the project the tasks go into." }),
  newProjectName: z.string().trim().max(120, "Keep the name under 120 characters.").optional(),
  ownerId: idSchema.optional().or(z.literal("").transform(() => undefined)),
  internId: idSchema.optional().or(z.literal("").transform(() => undefined)),
  /** The file's text pasted; the action also accepts the file itself (field "file"). */
  json: z.string().trim().max(2_000_000, "The file is too large for one import.").default(""),
});

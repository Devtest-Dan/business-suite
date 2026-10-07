import { z } from "zod";

export const MAX_BODY = 100_000;
export const MAX_STEPS = 100;

const uuid = z.string().uuid("That link is broken: the id is not valid. Go back and try again.");
const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(uuid.optional());
const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on");

export const titleField = z.string().trim().min(1, "Give the page a title.").max(200, "Keep the title under 200 characters.");
/** Without a default, for changes where "left out" must mean "unchanged" (not "empty"). */
const bodyText = z.string().max(MAX_BODY, "The page is too long (over 100,000 characters). Split it into two pages.");
export const bodyField = bodyText.default("");

/** One procedure step, as the editor, the AI and the import send it. */
export const stepInput = z.object({
  text: z.string().trim().min(1, "Every step needs some text. Remove empty steps.").max(500, "Keep each step under 500 characters; put detail in its note."),
  note: z.string().trim().max(2000, "Keep a step's note under 2,000 characters.").default(""),
  check: z.enum(["none", "yesno", "value"]).default("none"),
  checkLabel: z.string().trim().max(120, "Keep a check's question under 120 characters.").default(""),
});
/** Without a default, for changes where "left out" must mean "unchanged" (not "no steps"). */
const stepsList = z
  .array(stepInput)
  .max(MAX_STEPS, `A procedure can have at most ${MAX_STEPS} steps. Split it into two procedures.`)
  .superRefine((steps, ctx) => {
    steps.forEach((s, i) => {
      if (s.check !== "none" && !s.checkLabel) ctx.addIssue({ code: "custom", path: [i, "checkLabel"], message: `Step ${i + 1} has a check: write the question it asks.` });
    });
  });
export const stepsInput = stepsList.default([]);
export type StepInput = z.output<typeof stepInput>;

/** The editor sends the steps as JSON in a hidden field. */
const stepsJson = z
  .string()
  .default("[]")
  .transform((v, ctx) => {
    try {
      return JSON.parse(v || "[]") as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "The steps could not be read. Reload the page and try again." });
      return z.NEVER;
    }
  })
  .pipe(stepsInput);

export const kindField = z.enum(["page", "procedure"]).default("page");
export const scheduleField = z.enum(["none", "daily", "weekdays", "weekly"]).default("none");
const scheduleDayField = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? null : Number(v)))
  .pipe(z.number().int().min(0).max(6).nullable());

// ── Spaces ───────────────────────────────────────────────────────────────────

export const spaceForm = z.object({
  name: z.string().trim().min(1, "Give the space a name.").max(80, "Keep the name under 80 characters."),
  description: z.string().trim().max(500, "Keep the description under 500 characters.").default(""),
  visibility: z.enum(["team", "private"], { message: "Choose who can see the space." }),
});
export const spaceSettingsForm = spaceForm.extend({ spaceId: uuid });

export const memberForm = z.object({
  spaceId: uuid,
  userId: z.string().uuid("Choose a person."),
  role: z.enum(["viewer", "editor", "manager"], { message: "Choose what they may do in this space." }),
});
export const removeMemberForm = z.object({ spaceId: uuid, userId: uuid });

// ── Pages ────────────────────────────────────────────────────────────────────

const pageFields = {
  title: titleField,
  body: bodyField,
  kind: kindField,
  steps: stepsJson,
  schedule: scheduleField,
  scheduleDay: scheduleDayField,
  isTemplate: checkbox,
  note: z.string().trim().max(200, "Keep the change note under 200 characters.").default(""),
};

export const newPageForm = z.object({ spaceId: uuid, parentId: optionalUuid, ...pageFields });
export const editPageForm = z.object({
  pageId: uuid,
  parentId: optionalUuid,
  baseRevision: z.coerce.number().int().min(1),
  ...pageFields,
});
export type PageFields = Pick<z.output<typeof newPageForm>, "title" | "body" | "kind" | "steps" | "schedule" | "scheduleDay" | "isTemplate">;

export const pageIdForm = z.object({ pageId: uuid });
export const restoreForm = z.object({ pageId: uuid, revision: z.coerce.number().int().min(1) });
export const attachForm = z.object({ pageId: uuid, fileId: uuid, name: z.string().max(200), mime: z.string().max(200), size: z.number().int().min(0) });
export const removeAttachmentForm = z.object({ pageId: uuid, attachmentId: uuid });

// ── What the AI, other apps and imports may propose ─────────────────────────

/** A new page. Without `spaceId` it goes to the default space (the oldest team space). */
export const createPageInput = z.object({
  spaceId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  title: titleField,
  body: bodyField,
  kind: kindField,
  steps: stepsInput,
  note: z.string().trim().max(200).default(""),
});
export type CreatePageInput = z.output<typeof createPageInput>;

/** A change to an existing page, based on the revision the proposer read. Fields left out stay as they are. */
export const editPageInput = z.object({
  pageId: z.string().uuid(),
  baseRevision: z.number().int().min(1),
  title: titleField.optional(),
  body: bodyText.optional(),
  steps: stepsList.optional(),
  note: z.string().trim().max(200).default(""),
});
export type EditPageInput = z.output<typeof editPageInput>;

/** One Markdown file from an import. `folders` become parent pages (found by title, or made). */
export const importPageInput = z.object({
  spaceId: z.string().uuid(),
  path: z.string().trim().min(1).max(500),
  folders: z.array(titleField).max(10).default([]),
  title: titleField,
  body: bodyField,
  kind: kindField,
  steps: stepsInput,
  schedule: scheduleField,
});
export type ImportPageInput = z.output<typeof importPageInput>;

export const importForm = z.object({ spaceId: uuid });
export const MAX_IMPORT_FILES = 200;
export const MAX_IMPORT_FILE_BYTES = 200_000;

// ── Runs ─────────────────────────────────────────────────────────────────────

export const startRunForm = z.object({
  pageId: uuid,
  assignedTo: optionalUuid,
  dueOn: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the day as a date.").optional()),
});
export const stepDoneForm = z.object({
  runId: uuid,
  position: z.coerce.number().int().min(0).max(MAX_STEPS),
  answer: z.string().trim().max(500, "Keep the answer under 500 characters.").default(""),
});
export const runIdForm = z.object({ runId: uuid });

export const searchForm = z.object({ q: z.string().trim().max(200).default("") });

import { z } from "zod";

/** One announcement, as the form, the AI tool and the import all send it. */
export const announcementInput = z.object({
  title: z.string().trim().min(1, "Give the announcement a title.").max(160, "Keep the title under 160 characters."),
  body: z.string().trim().min(1, "Write the announcement itself.").max(10_000, "Keep the announcement under 10,000 characters."),
  pinned: z.boolean().default(false),
});
export type AnnouncementInput = z.output<typeof announcementInput>;

/** The post form: a checkbox arrives as "on" or not at all. */
export const announcementForm = z.object({
  title: announcementInput.shape.title,
  body: announcementInput.shape.body,
  pinned: z
    .string()
    .optional()
    .transform((v) => v === "on"),
});

export const importForm = z.object({
  csv: z.string().trim().min(1, "Paste the CSV text (a header row, then one announcement per row).").max(500_000, "That is too much text for one import. Split it into smaller batches."),
});

export const postIdSchema = z.string().uuid();

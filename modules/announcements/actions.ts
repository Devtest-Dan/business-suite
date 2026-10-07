"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { propose } from "@/lib/approvals/ledger";
import { parseCsv } from "@/lib/csv";
import { UserError } from "@/lib/errors";
import { formAction } from "@/lib/forms";
import { requireModule } from "@/lib/modules/server";
import { createPost, markRead, MODULE_ID, P, setPinned } from "./data";
import { announcementForm, importForm, postIdSchema } from "./schemas";

export const postAnnouncement = formAction(announcementForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.post);
  if (input.pinned && !ctx.can(P.pin)) throw new UserError("You can post but not pin. Untick “Pin to the top” or ask an admin to pin it.");
  const { post, announce } = await createPost(ctx.db, input, ctx.viewer);
  await announce();
  redirect(`/m/${MODULE_ID}/${post.id}`);
});

export async function togglePin(postId: string, pinned: boolean): Promise<void> {
  const id = postIdSchema.parse(postId);
  const ctx = await requireModule(MODULE_ID, P.pin);
  await setPinned(ctx, id, z.boolean().parse(pinned));
  refresh();
}

export async function markAnnouncementRead(postId: string): Promise<void> {
  const id = postIdSchema.parse(postId);
  const ctx = await requireModule(MODULE_ID, P.access);
  await markRead(ctx, id);
}

/**
 * A bulk import: every CSV row becomes one record of ONE approval. Nothing is
 * posted until someone approves; approving twice never posts a row twice.
 */
export const importAnnouncements = formAction(importForm, async ({ csv }) => {
  const ctx = await requireModule(MODULE_ID, P.import);
  const { header, rows } = parseCsv(csv);
  if (!header.includes("title") || !header.includes("body")) {
    throw new UserError('The first row must name the columns, with at least "title" and "body" (optional: "pinned", "key").');
  }
  if (rows.length === 0) throw new UserError("The CSV has a header row but no announcements under it.");
  const result = await propose({
    action: `${MODULE_ID}.post`,
    source: "import",
    requestedBy: ctx.viewer,
    title: `Import ${rows.length} announcement${rows.length === 1 ? "" : "s"}`,
    note: `${ctx.viewer.name} pasted a CSV with ${rows.length} row${rows.length === 1 ? "" : "s"}.`,
    items: rows.map((r) => ({ title: r.title, body: r.body, pinned: ["yes", "true", "1", "y"].includes((r.pinned ?? "").toLowerCase()) })),
    keys: rows.map((r) => (r.key ? `import:${r.key}` : null)),
  });
  if (!result.approvalId) {
    const why = result.invalid.length
      ? `No row could be used. First problem: row ${result.invalid[0].index + 2}: ${result.invalid[0].error}`
      : "Every row is already in the ledger from an earlier batch, so there is nothing new to approve.";
    throw new UserError(why);
  }
  redirect(`/approvals/${result.approvalId}`);
});

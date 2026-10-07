"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { approve, decline } from "@/lib/approvals/ledger";
import { requireViewer } from "@/lib/auth/session";
import { UserError } from "@/lib/errors";
import { formAction } from "@/lib/forms";
import { declineSchema } from "@/lib/schemas";

const approveSchema = z.object({
  approvalId: z.string().uuid(),
  mode: z.enum(["all", "selected", "retry"]),
});

/**
 * Approves and writes, then shows the approval again with what this click
 * did (the numbers travel in the URL; the page builds the sentence).
 */
export const approveAction = formAction(approveSchema, async ({ approvalId, mode }, formData) => {
  const viewer = await requireViewer();
  const selected = formData.getAll("item").map(String).filter((id) => z.string().uuid().safeParse(id).success);
  if (mode === "selected" && selected.length === 0) throw new UserError("Tick at least one record to approve, or use “Approve all”.");
  const report = await approve(approvalId, viewer, {
    selectedItemIds: mode === "selected" ? selected : undefined,
    retryFailed: mode === "retry",
  });
  const params = new URLSearchParams({
    written: String(report.appliedNow),
    failed: String(report.failedNow),
    handled: String(report.alreadyHandled),
    again: !report.firstDecision && mode !== "retry" ? "1" : "0",
  });
  redirect(`/approvals/${approvalId}?${params}`);
});

export const declineAction = formAction(declineSchema, async ({ approvalId, reason }) => {
  const viewer = await requireViewer();
  await decline(approvalId, viewer, reason);
  redirect(`/approvals/${approvalId}?declined=1`);
});

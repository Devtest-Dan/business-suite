import "server-only";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { cache } from "react";
import { canDecide } from "@/lib/approvals/ledger";
import { db } from "@/lib/db/client";
import { approvals, notifications } from "@/lib/db/schema";
import type { Viewer } from "@/lib/modules/contract";

/** Approvals still waiting that this person may decide (newest first). */
export const decidableApprovals = cache(async (viewer: Viewer) => {
  const waiting = await db()
    .select()
    .from(approvals)
    .where(inArray(approvals.status, ["pending"]))
    .orderBy(desc(approvals.createdAt))
    .limit(200);
  const out: typeof waiting = [];
  for (const a of waiting) if (await canDecide(viewer, a)) out.push(a);
  return out;
});

export const unreadNotificationCount = cache(async (viewer: Viewer): Promise<number> => {
  const [row] = await db()
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, viewer.id), isNull(notifications.readAt)));
  return row?.n ?? 0;
});

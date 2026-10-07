import "server-only";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import type { Viewer } from "@/lib/modules/contract";
import { permissionsFor } from "@/lib/permissions";

export type ActivityEntry = typeof auditLog.$inferSelect;

/**
 * Recent activity: everything for people with "activity.view", otherwise the
 * entries marked for everyone plus the person's own.
 */
export async function recentActivity(viewer: Viewer, options: { limit?: number; before?: number } = {}): Promise<ActivityEntry[]> {
  const all = (await permissionsFor(viewer.role)).has("activity.view");
  const visible = all ? undefined : or(eq(auditLog.visibility, "everyone"), eq(auditLog.actorId, viewer.id));
  const page = options.before ? lt(auditLog.id, options.before) : undefined;
  return db()
    .select()
    .from(auditLog)
    .where(and(visible, page))
    .orderBy(desc(auditLog.id))
    .limit(options.limit ?? 15);
}

import "server-only";
import { db, type Db, type DbTx } from "@/lib/db/client";
import { auditLog, type ActorKind, type Visibility } from "@/lib/db/schema";

export interface AuditEntry {
  actor: { id: string | null; name: string; kind: ActorKind };
  /** Dotted verb, e.g. "people.invited", "announcements.posted". */
  action: string;
  module?: string | null;
  target?: { type: string; id: string } | null;
  summary: string;
  data?: Record<string, unknown> | null;
  /** "everyone" shows the entry in every person's recent activity. */
  visibility?: Visibility;
}

export const SYSTEM_ACTOR = { id: null, name: "System", kind: "system" as const };

export function userActor(viewer: { id: string; name: string }) {
  return { id: viewer.id, name: viewer.name, kind: "user" as const };
}

/** Appends one entry. The table refuses updates and deletes (see drizzle/0001). */
export async function audit(entry: AuditEntry, tx?: DbTx | Db): Promise<void> {
  await (tx ?? db()).insert(auditLog).values({
    actorId: entry.actor.id,
    actorName: entry.actor.name,
    actorKind: entry.actor.kind,
    action: entry.action,
    module: entry.module ?? null,
    targetType: entry.target?.type ?? null,
    targetId: entry.target?.id ?? null,
    summary: entry.summary,
    data: entry.data ?? null,
    visibility: entry.visibility ?? "admins",
  });
}

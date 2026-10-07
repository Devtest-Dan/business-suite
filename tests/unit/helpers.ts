import { sql } from "drizzle-orm";
import { hashPassword } from "@/lib/auth/password";
import { db } from "@/lib/db/client";
import { users, type Role } from "@/lib/db/schema";
import type { Viewer } from "@/lib/modules/contract";

/** Empties every table except the append-only audit log. */
export async function resetDb(): Promise<void> {
  await db().execute(sql`
    truncate table approval_items, approvals, announcements_reads, announcements_posts, notifications,
      push_subscriptions, notification_prefs, files, invites, password_resets, sessions, auth_attempts,
      ai_conversations, role_permissions, module_state, settings, users restart identity cascade`);
}

let counter = 0;
let cachedHash: string | undefined;

export async function makeUser(role: Role, name?: string, password = "correct horse battery"): Promise<Viewer> {
  counter += 1;
  const hash = password === "correct horse battery" ? (cachedHash ??= await hashPassword(password)) : await hashPassword(password);
  const [u] = await db()
    .insert(users)
    .values({ email: `${role}${counter}@example.test`, name: name ?? `${role} ${counter}`, passwordHash: hash, role })
    .returning();
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

export async function countRows(table: string): Promise<number> {
  const rows = await db().execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`));
  return rows[0].n;
}

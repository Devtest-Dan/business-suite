import "server-only";
import { and, eq, gt, lt } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { newToken, sha256 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { UserError } from "@/lib/errors";
import { sessions, users } from "@/lib/db/schema";
import { isHttps } from "@/lib/env";
import type { ModuleContext, Viewer } from "@/lib/modules/contract";
import { permissionsFor } from "@/lib/permissions";
import { businessProfile } from "@/lib/settings";

export const SESSION_COOKIE = "suite_session";
const SESSION_DAYS = 30;

export async function clientIp(): Promise<string> {
  const h = await headers();
  // Caddy sets X-Forwarded-For; the first address is the visitor's.
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

/** Creates a database session and sets the httpOnly cookie. Call only from actions and routes. */
export async function startSession(userId: string): Promise<void> {
  const token = newToken();
  const h = await headers();
  await db()
    .insert(sessions)
    .values({
      id: sha256(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
      userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
      ip: await clientIp(),
    });
  await db().update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, userId));
  // Housekeeping: drop expired sessions.
  await db().delete(sessions).where(lt(sessions.expiresAt, new Date()));
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db().delete(sessions).where(eq(sessions.id, sha256(token)));
  jar.delete(SESSION_COOKIE);
}

/** Signs a person out everywhere (after a password change or when an account is switched off). */
export async function endAllSessions(userId: string): Promise<void> {
  await db().delete(sessions).where(eq(sessions.userId, userId));
}

/** The signed-in person, or null. Cached for the length of one request. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const id = sha256(token);
  const [row] = await db()
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())));
  if (!row || row.status !== "active") return null;
  if (Date.now() - row.lastSeenAt.getTime() > 3_600_000) {
    await db()
      .update(sessions)
      .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) })
      .where(eq(sessions.id, id));
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role };
});

/** For pages and layouts: the viewer, or a redirect to sign in. */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  return viewer;
}

export class PermissionError extends UserError {
  constructor(permission: string) {
    super(`You do not have permission for this (${permission}). Ask the owner to change your role or permissions.`);
    this.name = "PermissionError";
  }
}

export async function can(viewer: Viewer, permission: string): Promise<boolean> {
  return (await permissionsFor(viewer.role)).has(permission);
}

/** For actions and routes: throws PermissionError when the viewer lacks the permission. */
export async function requirePermission(permission: string): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new PermissionError("signed in");
  if (!(await can(viewer, permission))) throw new PermissionError(permission);
  return viewer;
}

/** The context a module's pages, tools and widgets receive. */
export async function moduleContext(moduleId: string, viewer: Viewer): Promise<ModuleContext> {
  const held = await permissionsFor(viewer.role);
  const business = await businessProfile();
  return { moduleId, viewer, db: db(), can: (p) => held.has(p), business: { name: business.name, timezone: business.timezone } };
}

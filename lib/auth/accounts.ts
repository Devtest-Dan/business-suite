import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { audit, SYSTEM_ACTOR, userActor } from "@/lib/audit";
import { burnPasswordCheck, hashPassword, verifyPassword } from "@/lib/auth/password";
import { isLimited, RATE_LIMITS, recordAttempt, SIGN_IN_WINDOW_MINUTES } from "@/lib/auth/rate-limit";
import { newToken, safeEqual, sha256 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { invites, moduleState, passwordResets, settings, users, type Role, type User } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { UserError } from "@/lib/errors";
import type { Viewer } from "@/lib/modules/contract";

export const INVITE_DAYS = 7;
export const RESET_HOURS = 24;

const toViewer = (u: Pick<User, "id" | "name" | "email" | "role">): Viewer => ({ id: u.id, name: u.name, email: u.email, role: u.role });

export function inviteLink(token: string): string {
  return `${env().publicUrl}/invite/${token}`;
}

export function resetLink(token: string): string {
  return `${env().publicUrl}/reset/${token}`;
}

// ── First run ────────────────────────────────────────────────────────────────

export interface OwnerInput {
  name: string;
  email: string;
  password: string;
  businessName: string;
  timezone: string;
  setupCode: string;
}

/**
 * Creates the one owner account. The "setup" settings row is the gate:
 * inserting it twice fails, so two people racing to the setup page cannot
 * both become owner.
 */
export async function createOwner(input: OwnerInput, ip: string): Promise<Viewer> {
  const expected = env().setupCode;
  if (expected) {
    const keys = RATE_LIMITS.setup(ip);
    if (await isLimited("setup", keys)) throw new UserError(`Too many wrong setup codes. Wait ${SIGN_IN_WINDOW_MINUTES} minutes and try again.`);
    if (!safeEqual(input.setupCode, expected)) {
      await recordAttempt("setup", keys, false);
      throw new UserError("That setup code is wrong. It is in the server's install output, or the SETUP_CODE line you put in the cloud-init text.");
    }
  }
  const passwordHash = await hashPassword(input.password);
  const owner = await db().transaction(async (tx) => {
    const gate = await tx
      .insert(settings)
      .values({ key: "setup", value: { completedAt: new Date().toISOString() } })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    if (gate.length === 0) throw new UserError("This suite is already set up. Sign in instead.");
    const [user] = await tx.insert(users).values({ email: input.email, name: input.name, passwordHash, role: "owner" }).returning();
    await tx
      .insert(settings)
      .values({ key: "business", value: { name: input.businessName, timezone: input.timezone, logoFileId: null }, updatedBy: user.id })
      .onConflictDoUpdate({ target: settings.key, set: { value: { name: input.businessName, timezone: input.timezone, logoFileId: null } } });
    return user;
  });
  await audit({ actor: userActor(owner), action: "setup.completed", summary: `${owner.name} set up the suite for ${input.businessName}.` });
  return toViewer(owner);
}

/** Runs each module's seed once (after setup, or when a module is first switched on). */
export async function seedModules(owner: Viewer): Promise<void> {
  const { installedModules } = await import("@/lib/modules/registry-access");
  const { moduleContext } = await import("@/lib/auth/session");
  for (const m of installedModules()) {
    const [state] = await db().select().from(moduleState).where(eq(moduleState.moduleId, m.id));
    if (state?.seededAt) continue;
    if (m.seed) await m.seed(await moduleContext(m.id, owner));
    await db()
      .insert(moduleState)
      .values({ moduleId: m.id, enabled: true, seededAt: new Date() })
      .onConflictDoUpdate({ target: moduleState.moduleId, set: { seededAt: new Date() } });
  }
}

// ── Sign in ──────────────────────────────────────────────────────────────────

export async function authenticate(email: string, password: string, ip: string): Promise<Viewer> {
  const keys = RATE_LIMITS.signIn(email, ip);
  if (await isLimited("sign_in", keys)) {
    throw new UserError(`Too many wrong passwords. Wait ${SIGN_IN_WINDOW_MINUTES} minutes and try again, or ask the owner for a reset link.`);
  }
  const [user] = await db().select().from(users).where(eq(users.email, email));
  const ok = user ? await verifyPassword(user.passwordHash, password) : (await burnPasswordCheck(password), false);
  if (!ok || !user) {
    await recordAttempt("sign_in", keys, false);
    throw new UserError("That email and password do not match an account here. Check both and try again.");
  }
  if (user.status !== "active") {
    throw new UserError("This account is switched off. Ask the owner or an admin to switch it back on.");
  }
  await recordAttempt("sign_in", keys, true);
  return toViewer(user);
}

// ── Invites ──────────────────────────────────────────────────────────────────

/** Only the owner may make admins; people with "people.manage" may invite members and guests. */
export function assertCanGrant(by: Viewer, role: Role): void {
  if (role === "owner") throw new UserError("There is one owner. Invite this person as an admin instead.");
  if (role === "admin" && by.role !== "owner") throw new UserError("Only the owner can make someone an admin.");
}

export async function createInvite(by: Viewer, email: string, role: Role): Promise<{ token: string; id: string }> {
  assertCanGrant(by, role);
  const [existing] = await db().select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw new UserError("Someone with this email already has an account. Find them under People.");
  const token = newToken();
  // A new invite for the same email replaces any open one.
  await db()
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.email, email), isNull(invites.acceptedAt), isNull(invites.revokedAt)));
  const [invite] = await db()
    .insert(invites)
    .values({ tokenHash: sha256(token), email, role, invitedBy: by.id, expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) })
    .returning({ id: invites.id });
  await audit({ actor: userActor(by), action: "people.invited", target: { type: "invite", id: invite.id }, summary: `${by.name} invited ${email} as ${role}.` });
  return { token, id: invite.id };
}

export async function openInvite(token: string) {
  const [invite] = await db()
    .select()
    .from(invites)
    .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date())));
  return invite ?? null;
}

export async function acceptInvite(token: string, name: string, password: string): Promise<Viewer> {
  const passwordHash = await hashPassword(password);
  const user = await db().transaction(async (tx) => {
    // Claim the invite first: one invite makes one account, even if the form is sent twice.
    const [invite] = await tx
      .update(invites)
      .set({ acceptedAt: new Date() })
      .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date())))
      .returning();
    if (!invite) throw new UserError("This invite link has expired or was already used. Ask whoever invited you for a new one.");
    const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, invite.email));
    if (taken) throw new UserError("An account with this email already exists. Sign in instead.");
    const [created] = await tx.insert(users).values({ email: invite.email, name, passwordHash, role: invite.role }).returning();
    await tx.update(invites).set({ acceptedUserId: created.id }).where(eq(invites.id, invite.id));
    return created;
  });
  await audit({ actor: userActor(user), action: "people.joined", target: { type: "user", id: user.id }, summary: `${user.name} accepted an invite and joined as ${user.role}.`, visibility: "everyone" });
  return toViewer(user);
}

// ── Password resets ──────────────────────────────────────────────────────────

export async function createReset(userId: string, by: Viewer | null): Promise<string> {
  const token = newToken();
  // Only the newest link works.
  await db().update(passwordResets).set({ usedAt: new Date() }).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
  await db()
    .insert(passwordResets)
    .values({ tokenHash: sha256(token), userId, createdBy: by?.id ?? null, expiresAt: new Date(Date.now() + RESET_HOURS * 3_600_000) });
  await audit({
    actor: by ? userActor(by) : SYSTEM_ACTOR,
    action: "people.reset_link",
    target: { type: "user", id: userId },
    summary: by ? `${by.name} made a password reset link.` : "A password reset email was requested.",
  });
  return token;
}

export async function openReset(token: string) {
  const [row] = await db()
    .select({ id: passwordResets.id, userId: passwordResets.userId, email: users.email, name: users.name })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())));
  return row ?? null;
}

export async function consumeReset(token: string, password: string): Promise<Viewer> {
  const passwordHash = await hashPassword(password);
  const user = await db().transaction(async (tx) => {
    const [reset] = await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
      .returning();
    if (!reset) throw new UserError("This reset link has expired or was already used. Ask for a new one.");
    const [u] = await tx.update(users).set({ passwordHash }).where(eq(users.id, reset.userId)).returning();
    return u;
  });
  await db().execute(sql`delete from sessions where user_id = ${user.id}`);
  await audit({ actor: userActor(user), action: "people.password_reset", target: { type: "user", id: user.id }, summary: `${user.name} set a new password with a reset link.` });
  return toViewer(user);
}

export async function changePassword(viewer: Viewer, current: string, next: string): Promise<void> {
  const [user] = await db().select().from(users).where(eq(users.id, viewer.id));
  if (!user || !(await verifyPassword(user.passwordHash, current))) throw new UserError("Your current password is not right. Type it again.");
  await db().update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, viewer.id));
  await audit({ actor: userActor(viewer), action: "people.password_changed", target: { type: "user", id: viewer.id }, summary: `${viewer.name} changed their password.` });
}

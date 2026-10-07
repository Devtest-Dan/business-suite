"use server";

import { and, eq, isNull } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { audit, userActor } from "@/lib/audit";
import { assertCanGrant, createInvite, createReset, inviteLink, resetLink } from "@/lib/auth/accounts";
import { endAllSessions, requirePermission } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { invites, users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import { formAction } from "@/lib/forms";
import { mailConfigured, sendMail } from "@/lib/mail";
import { ROLE_LABELS } from "@/lib/permissions";
import { changeRoleSchema, inviteSchema, userIdSchema } from "@/lib/schemas";
import { businessProfile } from "@/lib/settings";

export const inviteAction = formAction(inviteSchema, async ({ email, role }) => {
  const viewer = await requirePermission("people.manage");
  const { token, id } = await createInvite(viewer, email, role);
  const link = inviteLink(token);
  refresh();
  if (await mailConfigured()) {
    const business = await businessProfile();
    try {
      await sendMail({
        to: email,
        subject: `${viewer.name} invited you to ${business.name}`,
        text: `Hello,\n\n${viewer.name} invited you to ${business.name}'s suite as ${ROLE_LABELS[role].toLowerCase()}. Open this link to choose your name and password. It works once, for 7 days:\n\n${link}\n`,
      });
      await db().update(invites).set({ emailed: true }).where(eq(invites.id, id));
      return { ok: `Invite emailed to ${email}.` };
    } catch (error) {
      console.error("Invite email failed:", error);
      return { ok: `The invite email could not be sent (check Settings → Email). Copy this link and send it to ${email} yourself:`, data: { link, linkLabel: "Invite link" } };
    }
  }
  return { ok: `Invite made. This suite does not send email yet, so copy the link and send it to ${email} yourself. It works once, for 7 days.`, data: { link, linkLabel: "Invite link" } };
});

export async function revokeInvite(inviteId: string): Promise<void> {
  const viewer = await requirePermission("people.manage");
  const id = z.string().uuid().parse(inviteId);
  const [row] = await db().update(invites).set({ revokedAt: new Date() }).where(and(eq(invites.id, id), isNull(invites.acceptedAt))).returning();
  if (row) await audit({ actor: userActor(viewer), action: "people.invite_revoked", target: { type: "invite", id }, summary: `${viewer.name} cancelled the invite for ${row.email}.` });
  refresh();
}

async function target(userId: string, viewerId: string) {
  const [u] = await db().select().from(users).where(eq(users.id, userId));
  if (!u) throw new UserError("That person no longer exists. Reload the page.");
  if (u.role === "owner") throw new UserError("The owner's account cannot be changed here.");
  if (u.id === viewerId) throw new UserError("You cannot change your own role or switch yourself off.");
  return u;
}

export const changeRoleAction = formAction(changeRoleSchema, async ({ userId, role }) => {
  const viewer = await requirePermission("people.manage");
  const u = await target(userId, viewer.id);
  assertCanGrant(viewer, role);
  if (u.role === "admin" && viewer.role !== "owner") throw new UserError("Only the owner can change an admin's role.");
  await db().update(users).set({ role }).where(eq(users.id, u.id));
  await audit({ actor: userActor(viewer), action: "people.role_changed", target: { type: "user", id: u.id }, summary: `${viewer.name} changed ${u.name}'s role from ${u.role} to ${role}.` });
  refresh();
  return { ok: `${u.name} is now ${ROLE_LABELS[role].toLowerCase()}.` };
});

export const setActiveAction = formAction(userIdSchema.extend({ active: z.enum(["yes", "no"]) }), async ({ userId, active }) => {
  const viewer = await requirePermission("people.manage");
  const u = await target(userId, viewer.id);
  if (u.role === "admin" && viewer.role !== "owner") throw new UserError("Only the owner can switch an admin off.");
  const status = active === "yes" ? "active" : "disabled";
  await db().update(users).set({ status }).where(eq(users.id, u.id));
  if (status === "disabled") await endAllSessions(u.id);
  await audit({ actor: userActor(viewer), action: status === "active" ? "people.enabled" : "people.disabled", target: { type: "user", id: u.id }, summary: `${viewer.name} switched ${u.name}'s account ${status === "active" ? "on" : "off"}.` });
  refresh();
  return { ok: status === "active" ? `${u.name} can sign in again.` : `${u.name} is signed out everywhere and cannot sign in.` };
});

export const resetLinkAction = formAction(userIdSchema, async ({ userId }) => {
  const viewer = await requirePermission("people.manage");
  const [u] = await db().select().from(users).where(eq(users.id, userId));
  if (!u) throw new UserError("That person no longer exists. Reload the page.");
  if (u.role === "owner" && viewer.role !== "owner") throw new UserError("Only the owner can make a reset link for the owner.");
  const token = await createReset(u.id, viewer);
  return { ok: `Send this link to ${u.name} yourself. It works once, for 24 hours, and replaces any earlier link.`, data: { link: resetLink(token), linkLabel: "Reset link" } };
});

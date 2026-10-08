import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import webpush from "web-push";
import { seal, unseal } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { notificationPrefs, notifications, pushSubscriptions, users, type Role } from "@/lib/db/schema";
import { env } from "@/lib/env";
import type { NotificationKind, Viewer } from "@/lib/modules/contract";
import { installedModules } from "@/lib/modules/registry-access";
import { permissionsFor, ROLES } from "@/lib/permissions";
import { getSetting, setSetting } from "@/lib/settings";

export const CORE_NOTIFICATION_KINDS: NotificationKind[] = [
  { kind: "approvals.requested", label: "Something waits for your approval", pushByDefault: true },
  { kind: "approvals.finished", label: "An approval you asked for was decided", pushByDefault: false },
];

export function allNotificationKinds(): NotificationKind[] {
  return [...CORE_NOTIFICATION_KINDS, ...installedModules().flatMap((m) => m.notifications ?? [])];
}

export interface NewNotification {
  kind: string;
  title: string;
  body?: string;
  /** A path inside the suite, e.g. "/approvals/<id>". */
  url?: string;
}

/** In-app for everyone listed; Web Push for those whose preference allows it. */
export async function notify(userIds: string[], n: NewNotification): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  await db()
    .insert(notifications)
    .values(ids.map((userId) => ({ userId, kind: n.kind, title: n.title.slice(0, 200), body: n.body?.slice(0, 1000) ?? null, url: n.url ?? null })));
  await sendPush(ids, n).catch((error) => console.error(`Web Push failed: ${error instanceof Error ? error.message : error}`));
}

/** Everyone active whose role holds the permission. */
export async function usersWithPermission(permission: string): Promise<string[]> {
  const roles: Role[] = [];
  for (const role of ROLES) if ((await permissionsFor(role)).has(permission)) roles.push(role);
  if (roles.length === 0) return [];
  const rows = await db()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, roles)));
  return rows.map((r) => r.id);
}

export async function notifyApprovers(approvalId: string, actionPermission: string, requestedBy: Viewer | null, label: string, count: number): Promise<void> {
  const deciders = new Set(await usersWithPermission("approvals.decide"));
  if (requestedBy && (await permissionsFor(requestedBy.role)).has(actionPermission)) deciders.add(requestedBy.id);
  await notify([...deciders], {
    kind: "approvals.requested",
    title: count === 1 ? `Waiting for approval: ${label}` : `Waiting for approval: ${count} × ${label}`,
    url: `/approvals/${approvalId}`,
  });
}

/**
 * Once an approval is decided, the "waiting for approval" notices about it are
 * marked read for everyone, and the person who asked hears the outcome.
 */
export async function approvalDecided(approvalId: string, decidedBy: Viewer, requestedBy: string | null, title: string, outcome: string): Promise<void> {
  await db()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.url, `/approvals/${approvalId}`), eq(notifications.kind, "approvals.requested"), isNull(notifications.readAt)));
  if (requestedBy && requestedBy !== decidedBy.id) {
    await notify([requestedBy], { kind: "approvals.finished", title: `${decidedBy.name} ${outcome}: ${title}`, url: `/approvals/${approvalId}` });
  }
}

// ── Web Push ─────────────────────────────────────────────────────────────────

/**
 * The VAPID key pair, made on first use and kept in settings (private half sealed).
 * When the stored half cannot be opened (a restore onto a server with a different
 * SUITE_SECRET_KEY), a new pair is made and the old phone subscriptions, which only
 * work with the old pair, are forgotten: each person switches push off and on again.
 */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const stored = await getSetting("vapid");
  if (stored) {
    try {
      return { publicKey: stored.publicKey, privateKey: unseal(stored.privateKey) };
    } catch {
      console.warn("[push] the stored push key cannot be opened with this server's SUITE_SECRET_KEY; making a new one. Phones must switch push off and on again.");
      await db().delete(pushSubscriptions);
    }
  }
  const keys = webpush.generateVAPIDKeys();
  await setSetting("vapid", { publicKey: keys.publicKey, privateKey: seal(keys.privateKey) }, null);
  return keys;
}

async function pushWanted(userIds: string[], kind: string): Promise<string[]> {
  const def = allNotificationKinds().find((k) => k.kind === kind);
  const prefs = await db()
    .select()
    .from(notificationPrefs)
    .where(and(inArray(notificationPrefs.userId, userIds), eq(notificationPrefs.kind, kind)));
  const byUser = new Map(prefs.map((p) => [p.userId, p.push]));
  return userIds.filter((id) => byUser.get(id) ?? def?.pushByDefault ?? false);
}

async function sendPush(userIds: string[], n: NewNotification): Promise<void> {
  const wanted = await pushWanted(userIds, n.kind);
  if (wanted.length === 0) return;
  const subs = await db().select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, wanted));
  if (subs.length === 0) return;
  const keys = await vapidKeys();
  const subject = env().publicUrl.startsWith("https://") ? env().publicUrl : "mailto:owner@localhost";
  const payload = JSON.stringify({ title: n.title, body: n.body ?? "", url: n.url ?? "/" });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 86_400,
        });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        // 404/410: the browser dropped the subscription; forget it.
        if (status === 404 || status === 410) await db().delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
      }
    }),
  );
}

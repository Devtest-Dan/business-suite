"use server";

import { and, eq, isNull } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { requireViewer } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { notificationPrefs, notifications } from "@/lib/db/schema";
import { formAction } from "@/lib/forms";
import { allNotificationKinds } from "@/lib/notifications";

export async function markAllRead(): Promise<void> {
  const viewer = await requireViewer();
  await db()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, viewer.id), isNull(notifications.readAt)));
  refresh();
}

export async function markRead(id: string): Promise<void> {
  const viewer = await requireViewer();
  await db()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, z.string().uuid().parse(id)), eq(notifications.userId, viewer.id)));
  refresh();
}

/** One checkbox per notification kind: "push" on or off for this person. */
export const savePushPrefs = formAction(z.record(z.string(), z.string()), async (_input, formData) => {
  const viewer = await requireViewer();
  for (const k of allNotificationKinds()) {
    const push = formData.get(`push:${k.kind}`) === "on";
    await db()
      .insert(notificationPrefs)
      .values({ userId: viewer.id, kind: k.kind, push })
      .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.kind], set: { push } });
  }
  return { ok: "Saved. Push notifications follow these choices on every device you turned them on for." };
});

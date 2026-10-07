import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { ActionForm } from "@/components/action-form";
import { PushToggle } from "@/components/push-toggle";
import { requireViewer } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { notificationPrefs } from "@/lib/db/schema";
import { Icon } from "@/lib/icons";
import { allNotificationKinds, vapidKeys } from "@/lib/notifications";
import { ROLE_LABELS } from "@/lib/permissions";
import { savePushPrefs } from "../notifications/actions";
import { changePasswordAction, setTheme } from "./actions";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const viewer = await requireViewer();
  const theme = (await cookies()).get("suite_theme")?.value ?? "system";
  const { publicKey } = await vapidKeys();
  const prefs = new Map((await db().select().from(notificationPrefs).where(eq(notificationPrefs.userId, viewer.id))).map((p) => [p.kind, p.push]));
  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="h1">{viewer.name}</h1>
        <p className="muted">
          {viewer.email} · {ROLE_LABELS[viewer.role]}
        </p>
      </header>

      <section className="card space-y-3" aria-labelledby="theme">
        <h2 id="theme" className="h2">
          Look
        </h2>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["light", "Light", "sun"],
              ["dark", "Dark", "moon"],
              ["system", "Same as this device", "settings"],
            ] as const
          ).map(([value, label, icon]) => (
            <form key={value} action={setTheme.bind(null, value)}>
              <button type="submit" className={theme === value ? "btn btn-primary" : "btn"} aria-pressed={theme === value}>
                <Icon name={icon} className="size-4" /> {label}
              </button>
            </form>
          ))}
        </div>
      </section>

      <section className="card space-y-3" aria-labelledby="push" id="push">
        <h2 id="push-title" className="h2">
          Push notifications
        </h2>
        <p className="muted text-sm">Get notifications on this phone or computer even when the suite is closed.</p>
        <PushToggle publicKey={publicKey} />
        <ActionForm action={savePushPrefs} submit="Save choices" submitClassName="btn" className="space-y-2 border-t border-line pt-3">
          <p className="text-sm font-medium">Send a push for:</p>
          {allNotificationKinds().map((k) => (
            <label key={k.kind} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={`push:${k.kind}`} defaultChecked={prefs.get(k.kind) ?? k.pushByDefault} className="size-4" />
              {k.label}
            </label>
          ))}
          <p className="text-xs text-subtle">Everything always shows under Notifications in the suite.</p>
        </ActionForm>
      </section>

      <ActionForm action={changePasswordAction} submit="Change password" className="card space-y-4">
        <h2 className="h2">Password</h2>
        <label className="block">
          <span className="label">Current password</span>
          <input name="current" type="password" required autoComplete="current-password" className="input" />
        </label>
        <label className="block">
          <span className="label">New password</span>
          <input name="password" type="password" required minLength={10} autoComplete="new-password" className="input" />
        </label>
        <label className="block">
          <span className="label">New password again</span>
          <input name="confirm" type="password" required minLength={10} autoComplete="new-password" className="input" />
        </label>
      </ActionForm>
    </div>
  );
}

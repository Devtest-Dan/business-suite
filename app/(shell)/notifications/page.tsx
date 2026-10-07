import { desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { requireViewer } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { notifications } from "@/lib/db/schema";
import { formatDateTime } from "@/lib/format";
import { businessProfile } from "@/lib/settings";
import { markAllRead, markRead } from "./actions";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const viewer = await requireViewer();
  const business = await businessProfile();
  const rows = await db().select().from(notifications).where(eq(notifications.userId, viewer.id)).orderBy(desc(notifications.createdAt)).limit(100);
  const unread = rows.filter((r) => !r.readAt).length;
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Notifications</h1>
          <p className="muted">
            {unread ? `${unread} unread.` : "All read."} Push notifications on this device: <Link className="link" href="/account#push">Account</Link>.
          </p>
        </div>
        {unread ? (
          <form action={markAllRead}>
            <button className="btn" type="submit">
              Mark all as read
            </button>
          </form>
        ) : null}
      </header>
      {rows.length === 0 ? (
        <p className="card muted">No notifications yet.</p>
      ) : (
        <ul className="card divide-y divide-line p-0 sm:p-0">
          {rows.map((n) => (
            <li key={n.id} className="flex items-start gap-3 px-4 py-3">
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.readAt ? "bg-transparent" : "bg-accent"}`} aria-label={n.readAt ? undefined : "Unread"} />
              <div className="min-w-0 flex-1">
                {n.url ? (
                  <Link className="font-medium hover:underline" href={n.url}>
                    {n.title}
                  </Link>
                ) : (
                  <span className="font-medium">{n.title}</span>
                )}
                {n.body ? <p className="muted line-clamp-2 text-sm">{n.body}</p> : null}
                <p className="text-xs text-subtle">{formatDateTime(n.createdAt, business.timezone)}</p>
              </div>
              {!n.readAt ? (
                <form action={markRead.bind(null, n.id)}>
                  <button className="btn text-xs" type="submit">
                    Mark read
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

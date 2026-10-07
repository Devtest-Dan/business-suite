import { and, desc, eq, isNull } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { ActivityList } from "@/components/activity-list";
import { recentActivity } from "@/lib/activity";
import { moduleContext, requireViewer } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { notifications } from "@/lib/db/schema";
import { plural } from "@/lib/format";
import { Icon } from "@/lib/icons";
import { decidableApprovals } from "@/lib/inbox";
import type { NeedsMeItem } from "@/lib/modules/contract";
import { enabledModules } from "@/lib/modules/registry-access";
import { businessProfile } from "@/lib/settings";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  const viewer = await requireViewer();
  const [business, modules, waiting, activity] = await Promise.all([businessProfile(), enabledModules(), decidableApprovals(viewer), recentActivity(viewer, { limit: 10 })]);
  const unread = await db()
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, viewer.id), isNull(notifications.readAt)))
    .orderBy(desc(notifications.createdAt))
    .limit(3);

  const contexts = await Promise.all(modules.map(async (m) => ({ m, ctx: await moduleContext(m.id, viewer) })));
  const needs: (NeedsMeItem & { module: string })[] = [];
  const widgets: { id: string; title: string; body: React.ReactNode }[] = [];
  await Promise.all(
    contexts.map(async ({ m, ctx }) => {
      try {
        if (m.needsMe) for (const item of await m.needsMe(ctx)) needs.push({ ...item, module: m.name });
        if (m.widget && (!m.widget.permission || ctx.can(m.widget.permission))) widgets.push({ id: m.id, title: m.widget.title, body: await m.widget.render(ctx) });
      } catch (error) {
        console.error(`Home: module ${m.id} failed:`, error);
        widgets.push({ id: m.id, title: m.name, body: <p className="notice notice-error">This app could not load its summary. The rest of the page is fine.</p> });
      }
    }),
  );
  widgets.sort((a, b) => modules.findIndex((m) => m.id === a.id) - modules.findIndex((m) => m.id === b.id));
  const nothing = waiting.length === 0 && unread.length === 0 && needs.length === 0;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="h1">Hello, {viewer.name.split(" ")[0]}</h1>
        <p className="muted">{business.name}</p>
      </header>

      <section aria-labelledby="needs-me" className="space-y-3">
        <h2 id="needs-me" className="h2">
          What needs me
        </h2>
        {nothing ? (
          <p className="card muted">Nothing is waiting for you.</p>
        ) : (
          <ul className="card divide-y divide-line p-0 sm:p-0" data-testid="needs-me">
            {waiting.length ? (
              <li>
                <Link href="/approvals" className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  <Icon name="inbox" className="size-5 text-accent" />
                  <span className="flex-1">{plural(waiting.length, "approval")} waiting for your decision</span>
                  <span aria-hidden>→</span>
                </Link>
              </li>
            ) : null}
            {unread.map((n) => (
              <li key={n.id}>
                <Link href={n.url ?? "/notifications"} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  <Icon name="bell" className="size-5 text-accent" />
                  <span className="flex-1">{n.title}</span>
                </Link>
              </li>
            ))}
            {needs.map((item) => (
              <li key={item.url + item.title}>
                <Link href={item.url} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  <Icon name="check" className="size-5 text-accent" />
                  <span className="flex-1">
                    {item.title}
                    <span className="block text-xs text-subtle">
                      {item.module}
                      {item.detail ? ` · ${item.detail}` : ""}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {widgets.length ? (
        <section aria-label="Apps" className="grid gap-4 sm:grid-cols-2">
          {widgets.map((w) => (
            <div key={w.id} className="card space-y-2">
              <h2 className="font-semibold">{w.title}</h2>
              {w.body}
            </div>
          ))}
        </section>
      ) : null}

      <section aria-labelledby="recent" className="space-y-3">
        <h2 id="recent" className="h2">
          Recent activity
        </h2>
        <div className="card">
          <ActivityList entries={activity} timezone={business.timezone} />
        </div>
      </section>
    </div>
  );
}

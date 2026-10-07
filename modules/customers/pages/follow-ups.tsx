import Link from "next/link";
import type { ModulePageProps } from "@/lib/modules/contract";
import { deliverDueReminders, listFollowUps, P, todayIn } from "../data";
import { FollowUpList } from "./parts";

/** Follow-ups: mine by default, or the whole team's; open by default, or done. */
export async function FollowUpsPage({ ctx, searchParams, basePath }: ModulePageProps) {
  const who = searchParams.who === "team" ? "team" : "me";
  const status = searchParams.status === "done" ? "done" : "open";
  const tz = ctx.business.timezone;
  const today = todayIn(tz);
  await deliverDueReminders(ctx.db, ctx.viewer.id, tz);
  const items = await listFollowUps(ctx.db, { assigneeId: who === "me" ? ctx.viewer.id : undefined, status }, 300);
  const overdue = items.filter((f) => f.status === "open" && f.dueOn < today);
  const dueToday = items.filter((f) => f.status === "open" && f.dueOn === today);
  const later = items.filter((f) => f.status !== "open" || f.dueOn > today);
  const tab = (label: string, params: Record<string, string>, active: boolean) => (
    <Link href={`${basePath}/follow-ups?${new URLSearchParams(params)}`} className={`btn ${active ? "btn-primary" : ""}`} aria-current={active ? "page" : undefined}>
      {label}
    </Link>
  );
  const canEdit = ctx.can(P.edit);
  return (
    <div className="max-w-3xl space-y-5">
      <header>
        <h1 className="h1">Follow-ups</h1>
        <p className="muted">Reminders to call, write or meet a customer. Set them from a contact, company or deal.</p>
      </header>
      <nav className="flex flex-wrap gap-2" aria-label="Which follow-ups">
        {tab("Mine", { who: "me", status }, who === "me")}
        {tab("Everyone's", { who: "team", status }, who === "team")}
        <span className="mx-1 border-l border-line" aria-hidden />
        {tab("Open", { who, status: "open" }, status === "open")}
        {tab("Done", { who, status: "done" }, status === "done")}
      </nav>
      {status === "open" ? (
        <>
          <Group title="Overdue" items={overdue} tz={tz} today={today} canEdit={canEdit} />
          <Group title="Today" items={dueToday} tz={tz} today={today} canEdit={canEdit} />
          <Group title="Coming up" items={later} tz={tz} today={today} canEdit={canEdit} />
        </>
      ) : (
        <Group title="Done" items={later} tz={tz} today={today} canEdit={canEdit} />
      )}
    </div>
  );
}

function Group({ title, items, tz, today, canEdit }: { title: string; items: Parameters<typeof FollowUpList>[0]["items"]; tz: string; today: string; canEdit: boolean }) {
  return (
    <section className="card space-y-2" aria-label={title}>
      <h2 className="h2">
        {title} <span className="text-sm font-normal text-subtle">({items.length})</span>
      </h2>
      <FollowUpList items={items} tz={tz} today={today} canEdit={canEdit} showSubject />
    </section>
  );
}

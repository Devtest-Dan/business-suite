import type { Metadata } from "next";
import Link from "next/link";
import { ActivityList } from "@/components/activity-list";
import { recentActivity } from "@/lib/activity";
import { can, requireViewer } from "@/lib/auth/session";
import { businessProfile } from "@/lib/settings";

export const metadata: Metadata = { title: "Activity" };

const PAGE = 50;

/** The audit log. Append-only: the database refuses any change or deletion. */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const viewer = await requireViewer();
  const before = Number((await searchParams).before) || undefined;
  const entries = await recentActivity(viewer, { limit: PAGE, before });
  const business = await businessProfile();
  const all = await can(viewer, "activity.view");
  return (
    <div className="space-y-6">
      <header>
        <h1 className="h1">Activity</h1>
        <p className="muted">
          {all ? "Everything that happened in the suite, newest first." : "Shared activity and your own, newest first."} Entries cannot be edited or deleted, by anyone.
        </p>
      </header>
      <div className="card">
        <ActivityList entries={entries} timezone={business.timezone} />
      </div>
      {entries.length === PAGE ? (
        <Link className="btn" href={`/activity?before=${entries[entries.length - 1].id}`}>
          Older entries
        </Link>
      ) : null}
    </div>
  );
}

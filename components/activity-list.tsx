import type { ActivityEntry } from "@/lib/activity";
import { formatDateTime } from "@/lib/format";

export function ActivityList({ entries, timezone, empty = "Nothing has happened yet." }: { entries: ActivityEntry[]; timezone: string; empty?: string }) {
  if (entries.length === 0) return <p className="muted text-sm">{empty}</p>;
  return (
    <ol className="space-y-2" data-testid="activity-list">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-col gap-0.5 text-sm sm:flex-row sm:gap-3">
          <time className="shrink-0 text-xs text-subtle sm:w-40 sm:pt-0.5" dateTime={e.at.toISOString()}>
            {formatDateTime(e.at, timezone)}
          </time>
          <span>
            {e.summary}
            {e.actorKind === "ai" ? <span className="badge badge-accent ml-2">assistant</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

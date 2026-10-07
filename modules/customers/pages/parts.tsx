import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { formatDate, formatDateTime } from "@/lib/format";
import { addActivityAction, addFollowUpAction, deleteFilterAction, followUpStatusAction, saveFilterAction } from "../actions";
import { BASE, filterQueryString, followUpSubjectUrl, type FollowUpRow, type TimelineEntry } from "../data";
import type { FieldDef, ListFilter } from "../schemas";

/** Small building blocks shared by the Customers pages. */

export function Back({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="link text-sm">
      ← {label}
    </Link>
  );
}

export function Tags({ tags, basePath }: { tags: string[]; basePath?: string }) {
  if (!tags.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {tags.map((t) =>
        basePath ? (
          <Link key={t} href={`${basePath}?tag=${encodeURIComponent(t)}`} className="badge hover:underline">
            {t}
          </Link>
        ) : (
          <span key={t} className="badge">
            {t}
          </span>
        ),
      )}
    </span>
  );
}

type Person = { id: string; name: string };

export function PersonSelect({ people, name, label, value, emptyLabel = "Nobody" }: { people: Person[]; name: string; label: string; value: string | null; emptyLabel?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <select name={name} defaultValue={value ?? ""} className="input">
        <option value="">{emptyLabel}</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CustomFieldInputs({ fields, values }: { fields: FieldDef[]; values: Record<string, string> }) {
  if (!fields.length) return null;
  return (
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="label">Custom fields</legend>
      {fields.map((f) => (
        <label key={f.key} className="block">
          <span className="label">{f.label}</span>
          {f.type === "choice" ? (
            <select name={`custom.${f.key}`} defaultValue={values[f.key] ?? ""} className="input">
              <option value="">Not set</option>
              {f.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              name={`custom.${f.key}`}
              defaultValue={values[f.key] ?? ""}
              type={f.type === "date" ? "date" : "text"}
              inputMode={f.type === "number" ? "decimal" : undefined}
              maxLength={500}
              className="input"
            />
          )}
        </label>
      ))}
    </fieldset>
  );
}

export function Details({ rows }: { rows: [string, React.ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== "" && v !== null && v !== undefined);
  if (!shown.length) return null;
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-subtle">{k}</dt>
          <dd className="min-w-0 break-words whitespace-pre-line">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function customRows(fields: FieldDef[], values: Record<string, string>): [string, string][] {
  return fields.map((f) => [f.label, values[f.key] ?? ""]);
}

/** A filter bar (a plain GET form, so filters live in the URL and can be saved). */
export function FilterBar({ action, filter, people, tags = true, children }: { action: string; filter: ListFilter; people: Person[]; tags?: boolean; children?: React.ReactNode }) {
  return (
    <form action={action} method="get" className="card grid gap-3 sm:grid-cols-[1fr_10rem_12rem_auto] sm:items-end" role="search">
      <label className="block">
        <span className="label">Search</span>
        <input name="q" defaultValue={filter.q} className="input" placeholder="Name, email, phone or a word" />
      </label>
      {tags ? (
        <label className="block">
          <span className="label">Tag</span>
          <input name="tag" defaultValue={filter.tag} className="input" placeholder="e.g. vip" />
        </label>
      ) : null}
      <label className="block">
        <span className="label">Owner</span>
        <select name="owner" defaultValue={filter.owner} className="input">
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="none">Nobody</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {children}
      <div className="flex gap-2">
        <button className="btn btn-primary" type="submit">
          Filter
        </button>
        <Link href={action} className="btn">
          Clear
        </Link>
      </div>
    </form>
  );
}

export function SavedFilters({
  entity,
  basePath,
  filters,
  current,
  viewerId,
  canShare,
  canManageAll,
}: {
  entity: "contacts" | "companies" | "deals";
  basePath: string;
  filters: { id: string; name: string; query: Record<string, string>; shared: boolean; userId: string }[];
  current: ListFilter;
  viewerId: string;
  canShare: boolean;
  canManageAll: boolean;
}) {
  const query = filterQueryString(current as unknown as Record<string, string>).replace(/^\?/, "");
  if (!filters.length && !query) return null;
  return (
    <section className="flex flex-wrap items-center gap-2" aria-label="Saved filters" data-testid="saved-filters">
      {filters.length ? <span className="text-sm text-subtle">Saved:</span> : null}
      {filters.map((f) => (
        <span key={f.id} className="inline-flex items-center gap-1">
          <Link href={`${basePath}${filterQueryString(f.query)}`} className="badge badge-accent hover:underline">
            {f.name}
            {f.shared ? " · team" : ""}
          </Link>
          {f.userId === viewerId || canManageAll ? (
            <form action={deleteFilterAction.bind(null, f.id)}>
              <button type="submit" className="text-xs text-subtle hover:underline" aria-label={`Remove the saved filter ${f.name}`}>
                ×
              </button>
            </form>
          ) : null}
        </span>
      ))}
      {query ? (
        <details className="w-full sm:w-auto">
          <summary className="link cursor-pointer text-sm">Save this filter</summary>
          <ActionForm action={saveFilterAction} submit="Save filter" className="mt-2 flex flex-wrap items-end gap-2" resetOnSuccess>
            <input type="hidden" name="entity" value={entity} />
            <input type="hidden" name="query" value={query} />
            <label className="block">
              <span className="label">Name</span>
              <input name="name" required maxLength={60} className="input" />
            </label>
            {canShare ? (
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" name="shared" className="size-4" /> Share with the team
              </label>
            ) : null}
          </ActionForm>
        </details>
      ) : null}
    </section>
  );
}

const KIND_LABEL: Record<TimelineEntry["kind"], string> = { call: "Call", email: "Email", meeting: "Meeting", note: "Note", stage_change: "Stage" };

export function Timeline({ entries, tz, showDeal = true }: { entries: TimelineEntry[]; tz: string; showDeal?: boolean }) {
  if (!entries.length) return <p className="muted text-sm">Nothing logged yet. Add a call, email, meeting or note above.</p>;
  return (
    <ol className="space-y-3" data-testid="timeline">
      {entries.map((e) => (
        <li key={e.id} className="border-l-2 border-line pl-3">
          <p className="text-xs text-subtle">
            <span className={`badge ${e.kind === "stage_change" ? "badge-accent" : ""}`}>{KIND_LABEL[e.kind]}</span> {formatDateTime(e.occurredAt, tz)} · {e.authorName}
            {e.via === "ai" ? " · drafted by the assistant" : ""}
            {showDeal && e.dealId && e.dealTitle ? (
              <>
                {" · "}
                <Link className="link" href={`${BASE}/deals/${e.dealId}`}>
                  {e.dealTitle}
                </Link>
              </>
            ) : null}
            {e.contactId && e.contactName && !showDeal ? ` · ${e.contactName}` : ""}
          </p>
          <p className="mt-1 whitespace-pre-line text-sm">{e.body}</p>
        </li>
      ))}
    </ol>
  );
}

type Subject = { contactId?: string; companyId?: string; dealId?: string };

function SubjectInputs({ subject }: { subject: Subject }) {
  return (
    <>
      {subject.contactId ? <input type="hidden" name="contactId" value={subject.contactId} /> : null}
      {subject.companyId ? <input type="hidden" name="companyId" value={subject.companyId} /> : null}
      {subject.dealId ? <input type="hidden" name="dealId" value={subject.dealId} /> : null}
    </>
  );
}

export function ActivityForm({ subject, today }: { subject: Subject; today: string }) {
  return (
    <ActionForm action={addActivityAction} submit="Add to timeline" className="space-y-3" resetOnSuccess>
      <SubjectInputs subject={subject} />
      <div className="grid gap-3 sm:grid-cols-[10rem_10rem]">
        <label className="block">
          <span className="label">What</span>
          <select name="kind" className="input" defaultValue="note">
            <option value="call">Call</option>
            <option value="email">Email</option>
            <option value="meeting">Meeting</option>
            <option value="note">Note</option>
          </select>
        </label>
        <label className="block">
          <span className="label">When</span>
          <input type="date" name="occurredOn" defaultValue={today} max={today} className="input" />
        </label>
      </div>
      <label className="block">
        <span className="label">What happened</span>
        <textarea name="body" required rows={3} maxLength={5000} className="input" />
        <span className="hint">Never write card numbers here: they are refused.</span>
      </label>
    </ActionForm>
  );
}

export function FollowUpForm({ subject, people, viewerId, today, tasksOn }: { subject: Subject; people: Person[]; viewerId: string; today: string; tasksOn: boolean }) {
  return (
    <ActionForm action={addFollowUpAction} submit="Set follow-up" className="space-y-3" resetOnSuccess>
      <SubjectInputs subject={subject} />
      <label className="block">
        <span className="label">What needs doing</span>
        <input name="title" required maxLength={200} className="input" placeholder="e.g. Call back about the quote" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">Due</span>
          <input type="date" name="dueOn" required min={today} defaultValue={today} className="input" />
        </label>
        <PersonSelect people={people} name="assigneeId" label="For" value={viewerId} emptyLabel="Me" />
      </div>
      <p className="hint">{tasksOn ? "It is added as a task in the Tasks app." : "You get a reminder on the home page and a notification when it is due."}</p>
    </ActionForm>
  );
}

export function FollowUpList({ items, tz, today, canEdit, showSubject = false }: { items: FollowUpRow[]; tz: string; today: string; canEdit: boolean; showSubject?: boolean }) {
  if (!items.length) return <p className="muted text-sm">No follow-ups.</p>;
  return (
    <ul className="divide-y divide-line" data-testid="follow-up-list">
      {items.map((f) => (
        <li key={f.id} className="flex flex-wrap items-start gap-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {f.title}{" "}
              {f.status === "open" && f.dueOn < today ? <span className="badge badge-danger">Overdue</span> : null}
              {f.status === "open" && f.dueOn === today ? <span className="badge badge-warn">Today</span> : null}
              {f.status !== "open" ? <span className="badge badge-ok">{f.status === "done" ? "Done" : "Cancelled"}</span> : null}
              {f.via === "tasks" ? <span className="badge badge-accent">In Tasks</span> : null}
            </p>
            <p className="text-xs text-subtle">
              Due {formatDate(`${f.dueOn}T12:00:00Z`, tz)}
              {f.assigneeName ? ` · for ${f.assigneeName}` : ""}
              {showSubject ? (
                <>
                  {" · "}
                  <Link className="link" href={followUpSubjectUrl(f)}>
                    {f.contactName ?? f.companyName ?? f.dealTitle ?? "customer"}
                  </Link>
                </>
              ) : null}
              {f.via === "tasks" && f.taskApprovalId && !f.taskId ? (
                <>
                  {" · "}
                  <Link className="link" href={`/approvals/${f.taskApprovalId}`}>
                    task waiting for approval
                  </Link>
                </>
              ) : null}
            </p>
          </div>
          {canEdit && f.status === "open" ? (
            <form action={followUpStatusAction.bind(null, f.id, "done")}>
              <button type="submit" className="btn">
                Done
              </button>
            </form>
          ) : null}
          {canEdit && f.status !== "open" ? (
            <form action={followUpStatusAction.bind(null, f.id, "open")}>
              <button type="submit" className="btn">
                Reopen
              </button>
            </form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Delete behind a second click (no script needed). */
export function DeleteButton({ action, what }: { action: () => Promise<void>; what: string }) {
  return (
    <details className="inline-block">
      <summary className="btn btn-danger cursor-pointer list-none">Delete</summary>
      <form action={action} className="card mt-2 space-y-2">
        <p className="text-sm">Delete {what}? This cannot be undone.</p>
        <button type="submit" className="btn btn-danger">
          Yes, delete
        </button>
      </form>
    </details>
  );
}

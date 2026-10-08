import Link from "next/link";
import { formatMinutes, STATUS_LABELS, type LeadStatus } from "../logic";

/** Small building blocks shared by the Leads pages. */

export function Back({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="link text-sm">
      ← {label}
    </Link>
  );
}

const STATUS_BADGE: Record<LeadStatus, string> = {
  new: "badge badge-accent",
  contacted: "badge",
  qualified: "badge badge-warn",
  converted: "badge badge-ok",
  disqualified: "badge badge-danger",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={STATUS_BADGE[status as LeadStatus] ?? "badge"}>{STATUS_LABELS[status as LeadStatus] ?? status}</span>;
}

/** Waiting time of a new lead, or its speed to lead; red when over the owner's target. */
export function Speed({ minutes, over, contacted, target }: { minutes: number | null; over: boolean; contacted: boolean; target: number }) {
  if (minutes === null) return <span className="text-subtle">—</span>;
  const text = contacted ? `Contacted after ${formatMinutes(minutes)}` : `Waiting ${formatMinutes(minutes)}`;
  return (
    <span className={over ? "font-medium text-danger" : contacted ? "text-ok" : ""} title={over ? `Over your ${target}-minute target` : `Within your ${target}-minute target`} data-over={over ? "yes" : "no"}>
      {text}
      {over ? <span className="sr-only"> (over the {target}-minute target)</span> : null}
    </span>
  );
}

export function PersonSelect({ people, name, label, value, emptyLabel = "Nobody" }: { people: { id: string; name: string }[]; name: string; label: string; value: string | null; emptyLabel?: string }) {
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

export function SubNav({ basePath, current, canManage }: { basePath: string; current: string; canManage: boolean }) {
  const items = [
    { path: "", label: "Leads" },
    { path: "report", label: "Report" },
    ...(canManage
      ? [
          { path: "forms", label: "Forms" },
          { path: "sequences", label: "Sequences" },
          { path: "settings", label: "Settings" },
        ]
      : []),
  ];
  return (
    <nav aria-label="Leads" className="flex flex-wrap gap-1 text-sm">
      {items.map((i) => (
        <Link key={i.path} href={`${basePath}${i.path ? `/${i.path}` : ""}`} className={`btn ${current === i.path ? "btn-primary" : ""}`} aria-current={current === i.path ? "page" : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

import type { FactStatus } from "../facts";

const LABELS: Record<FactStatus, { label: string; className: string } | null> = {
  active: null,
  corrected: { label: "Corrected", className: "badge badge-accent" },
  withdrawn: { label: "Withdrawn", className: "badge badge-danger" },
};

export function StatusBadge({ status }: { status: FactStatus }) {
  const s = LABELS[status];
  return s ? <span className={s.className}>{s.label}</span> : null;
}

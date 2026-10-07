import type { ApprovalItemStatus, ApprovalStatus } from "@/lib/db/schema";

const APPROVAL: Record<ApprovalStatus, { label: string; tone: string }> = {
  pending: { label: "Waiting", tone: "badge-warn" },
  running: { label: "Writing", tone: "badge-accent" },
  applied: { label: "Done", tone: "badge-ok" },
  partially_applied: { label: "Partly done", tone: "badge-danger" },
  failed: { label: "Failed", tone: "badge-danger" },
  declined: { label: "Declined", tone: "" },
};

const ITEM: Record<ApprovalItemStatus, { label: string; tone: string }> = {
  pending: { label: "Waiting", tone: "badge-warn" },
  claimed: { label: "Writing", tone: "badge-accent" },
  applied: { label: "Written", tone: "badge-ok" },
  failed: { label: "Failed", tone: "badge-danger" },
  skipped: { label: "Left out", tone: "" },
};

export function ApprovalBadge({ status }: { status: ApprovalStatus }) {
  const s = APPROVAL[status];
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

export function ItemBadge({ status }: { status: ApprovalItemStatus }) {
  const s = ITEM[status];
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

export const SOURCE_LABEL = { ai: "Assistant", import: "Import", user: "Person" } as const;

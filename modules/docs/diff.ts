/**
 * A line diff for page history and approvals (no dependency). Common lines at
 * the start and end are matched first; the middle uses a longest-common-
 * subsequence table, which is fine for the size of a wiki page. Very large
 * changes fall back to "these lines were replaced by those".
 */

export type DiffOp = { type: "same" | "add" | "del"; text: string };

/** Above this many cells (middle lines × middle lines) the table is skipped. */
const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before.replace(/\r\n?/g, "\n").split("\n");
  const b = after.replace(/\r\n?/g, "\n").split("\n");
  if (before === "") a.length = 0;
  if (after === "") b.length = 0;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffOp[] = a.slice(0, start).map((text) => ({ type: "same", text }));
  const tail: DiffOp[] = a.slice(endA).map((text) => ({ type: "same", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  return [...head, ...middle(midA, midB), ...tail];
}

function middle(a: string[], b: string[]): DiffOp[] {
  if (a.length === 0) return b.map((text) => ({ type: "add", text }));
  if (b.length === 0) return a.map((text) => ({ type: "del", text }));
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ type: "del" as const, text })), ...b.map((text) => ({ type: "add" as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..], stored row by row.
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
      out.push({ type: "del", text: a[i++] });
    } else {
      out.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  return { added: ops.filter((o) => o.type === "add").length, removed: ops.filter((o) => o.type === "del").length };
}

export type Hunk = { type: "ops"; ops: DiffOp[] } | { type: "gap"; count: number };

/** Keeps `context` unchanged lines around each change and folds the rest. */
export function hunks(ops: DiffOp[], context = 2): Hunk[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type === "same") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: Hunk[] = [];
  let gap = 0;
  let current: DiffOp[] = [];
  ops.forEach((op, idx) => {
    if (keep[idx]) {
      if (gap) out.push({ type: "gap", count: gap });
      gap = 0;
      current.push(op);
    } else {
      if (current.length) out.push({ type: "ops", ops: current });
      current = [];
      gap++;
    }
  });
  if (current.length) out.push({ type: "ops", ops: current });
  if (gap) out.push({ type: "gap", count: gap });
  return out;
}

/** A procedure's steps as text lines, so step changes show in the same diff. */
export function stepsAsText(steps: { text: string; note: string; check: string; checkLabel: string }[]): string {
  return steps
    .map((s, i) => {
      const check = s.check === "yesno" ? ` [check: yes/no: ${s.checkLabel}]` : s.check === "value" ? ` [check: record ${s.checkLabel}]` : "";
      return `${i + 1}. ${s.text}${check}${s.note ? `\n   ${s.note.replace(/\n/g, "\n   ")}` : ""}`;
    })
    .join("\n");
}

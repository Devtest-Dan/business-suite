import { diffStats, hunks, lineDiff } from "../diff";

/** A line diff, folded to the changes with two lines around each. Works at phone width (lines wrap). */
export function DiffView({ before, after, label }: { before: string; after: string; label?: string }) {
  const ops = lineDiff(before, after);
  const { added, removed } = diffStats(ops);
  if (added === 0 && removed === 0) return <p className="text-sm text-subtle">{label ? `${label}: ` : ""}no change.</p>;
  return (
    <div className="space-y-1" data-testid="diff">
      <p className="text-xs text-subtle">
        {label ? `${label}: ` : ""}
        <span className="text-ok">+{added}</span> <span className="text-danger">−{removed}</span> line{added + removed === 1 ? "" : "s"}
      </p>
      <div className="overflow-hidden rounded-lg border border-line font-mono text-xs leading-relaxed">
        {hunks(ops).map((h, hi) =>
          h.type === "gap" ? (
            <div key={hi} className="bg-surface-2 px-2 py-0.5 text-subtle">
              … {h.count} unchanged line{h.count === 1 ? "" : "s"}
            </div>
          ) : (
            h.ops.map((op, oi) => (
              <div
                key={`${hi}-${oi}`}
                className={`whitespace-pre-wrap break-words px-2 ${op.type === "add" ? "bg-ok/10 text-ok" : op.type === "del" ? "bg-danger/10 text-danger line-through decoration-danger/40" : ""}`}
                data-op={op.type}
              >
                <span aria-hidden="true" className="mr-2 select-none">
                  {op.type === "add" ? "+" : op.type === "del" ? "−" : " "}
                </span>
                <span className="sr-only">{op.type === "add" ? "Added: " : op.type === "del" ? "Removed: " : ""}</span>
                {op.text || " "}
              </div>
            ))
          ),
        )}
      </div>
    </div>
  );
}

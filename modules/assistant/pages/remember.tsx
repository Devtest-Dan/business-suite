import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { rememberFact } from "../actions";
import { FACT_KIND_LABELS, FACT_KINDS } from "../schemas";

const one = (v: string | string[] | undefined, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * "Remember this": the entry point other apps link to (only when this app is
 * switched on), e.g. /m/assistant/remember?text=…&from=Announcements%3A%20Closed%20Friday&url=/m/announcements/<id>.
 * The person reads the text, edits it into one plain fact and saves it.
 */
export function RememberPage({ searchParams, basePath }: ModulePageProps) {
  const text = one(searchParams.text, 2000);
  const from = one(searchParams.from, 300);
  const url = one(searchParams.url, 500);
  const safeUrl = /^\/(?!\/)[^\s]*$/.test(url) ? url : "";
  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-1">
        <Link href={`${basePath}/facts`} className="link text-sm">
          ← What the assistant knows
        </Link>
        <h1 className="h1">Remember this</h1>
        <p className="muted">Turn it into one plain fact the assistant and the team&apos;s agents should know. Keep only what will still be true later.</p>
      </header>
      <ActionForm action={rememberFact} submit="Remember this" className="card space-y-3">
        <label className="block">
          <span className="label">The fact</span>
          <textarea name="text" required rows={5} maxLength={2000} defaultValue={text} className="input" />
          <span className="hint">Secrets and card numbers are always removed; personal details are replaced with placeholders unless the owner changed that.</span>
        </label>
        <label className="block max-w-xs">
          <span className="label">Kind</span>
          <select name="kind" defaultValue="fact" className="input">
            {FACT_KINDS.map((k) => (
              <option key={k} value={k}>
                {FACT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Where it came from (optional)</span>
          <input name="from" maxLength={300} defaultValue={from} className="input" />
        </label>
        <input type="hidden" name="url" value={safeUrl} />
        {safeUrl ? (
          <p className="text-sm">
            Links back to{" "}
            <Link className="link" href={safeUrl}>
              {safeUrl}
            </Link>
          </p>
        ) : null}
      </ActionForm>
    </div>
  );
}

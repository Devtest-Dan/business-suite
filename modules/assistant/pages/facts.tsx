import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { formatDate } from "@/lib/format";
import type { ModulePageProps } from "@/lib/modules/contract";
import { rememberFact, syncBrain } from "../actions";
import { brain } from "../brain";
import { adoptFromBrain, countFacts, countPendingForBrain, listFacts, SOURCE_LABELS } from "../facts";
import { P } from "../ids";
import { FACT_KIND_LABELS, FACT_KINDS } from "../schemas";
import { StatusBadge } from "./status-badge";

const PAGE = 50;

export async function FactsPage({ ctx, searchParams, basePath }: ModulePageProps) {
  const q = typeof searchParams.q === "string" ? searchParams.q.slice(0, 200) : "";
  const show = searchParams.show === "withdrawn" ? "withdrawn" : "current";
  const page = Math.max(0, Number(searchParams.page) || 0);
  const b = brain();
  let brainState: { ok: boolean; version: string | null; detail?: string } | null = null;
  if (b) {
    brainState = await b.health();
    // Facts a coding agent or another tool wrote straight into the brain show up here.
    if (brainState.ok && ctx.can(P.curate)) await adoptFromBrain().catch(() => 0);
  }
  const [facts, total, pending] = await Promise.all([
    listFacts(ctx.db, { q, status: show, limit: PAGE + 1, offset: page * PAGE }),
    countFacts(ctx.db),
    b ? countPendingForBrain() : Promise.resolve(0),
  ]);
  const more = facts.length > PAGE;
  const tz = ctx.business.timezone;
  const link = (extra: Record<string, string | number>) => {
    const p = new URLSearchParams({ ...(q ? { q } : {}), ...(show === "withdrawn" ? { show } : {}), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) });
    const s = p.toString();
    return s ? `${basePath}/facts?${s}` : `${basePath}/facts`;
  };

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="h1">What the assistant knows</h1>
        <p className="muted">
          Facts about how this business works, so nobody has to ask twice. The assistant recalls them when it answers; coding agents you give access can recall them and
          add notes, but never change or delete yours. Correct or withdraw any fact at any time.
        </p>
        <p className="text-sm" data-testid="brain-status">
          {!b ? (
            <>
              <span className="badge">Brain off</span> Facts are kept in the suite&apos;s own database and searched by keyword. Switching the brain on lets coding agents
              connect (docs/apps/assistant.md).
            </>
          ) : brainState?.ok ? (
            <>
              <span className="badge badge-ok">Brain on</span> GBrain {brainState.version ?? ""}, keyword search only: nothing in it is sent to an AI service to be
              searched.
            </>
          ) : (
            <>
              <span className="badge badge-danger">Brain not answering</span> The facts below are safe in the suite&apos;s database; new ones are sent to the brain when it is
              back. ({brainState?.detail})
            </>
          )}
        </p>
      </header>

      {ctx.can(P.remember) ? (
        <ActionForm action={rememberFact} submit="Remember this" className="card space-y-3" resetOnSuccess>
          <h2 className="h2">Add a fact</h2>
          <label className="block">
            <span className="label">The fact, in plain words</span>
            <textarea name="text" required rows={3} maxLength={2000} className="input" placeholder="e.g. Deliveries come on Tuesdays before 10:00; sign for them at the back door." />
            <span className="hint">One fact per entry. Secrets and card numbers are always removed{"; "}personal details are replaced with placeholders unless the owner changed that.</span>
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
        </ActionForm>
      ) : null}

      <section className="space-y-3" aria-labelledby="facts-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="facts-heading" className="h2">
            {show === "withdrawn" ? "Withdrawn facts" : `${total} current fact${total === 1 ? "" : "s"}`}
          </h2>
          <div className="flex flex-wrap gap-2 text-sm">
            <Link className="link" href={show === "withdrawn" ? `${basePath}/facts` : `${basePath}/facts?show=withdrawn`}>
              {show === "withdrawn" ? "Show current facts" : "Show withdrawn facts"}
            </Link>
            {ctx.can(P.import) ? (
              <Link className="link" href={`${basePath}/import`}>
                Import a memory export
              </Link>
            ) : null}
            {ctx.can(P.agents) ? (
              <Link className="link" href={`${basePath}/agents`}>
                Coding agents
              </Link>
            ) : null}
          </div>
        </div>
        <form className="flex gap-2" action={`${basePath}/facts`}>
          {show === "withdrawn" ? <input type="hidden" name="show" value="withdrawn" /> : null}
          <input name="q" defaultValue={q} className="input" placeholder="Search, e.g. refunds" aria-label="Search facts" />
          <button className="btn" type="submit">
            Search
          </button>
        </form>
        {b && ctx.can(P.curate) ? (
          <ActionForm action={syncBrain} submit={pending ? `Send ${pending} waiting fact${pending === 1 ? "" : "s"} to the brain` : "Sync with the brain"} submitClassName="btn" className="space-y-2">
            {pending ? <p className="muted text-sm">{pending} fact{pending === 1 ? " is" : "s are"} not in the brain yet.</p> : null}
          </ActionForm>
        ) : null}
        {facts.length === 0 ? (
          <p className="card muted">{q ? `No facts match “${q}”.` : show === "withdrawn" ? "Nothing has been withdrawn." : "Nothing yet. Add the first fact above."}</p>
        ) : (
          <ul className="card divide-y divide-line p-0 sm:p-0" data-testid="facts">
            {facts.slice(0, PAGE).map((f) => (
              <li key={f.id} className="space-y-1 p-4">
                <Link href={`${basePath}/facts/${f.id}`} className="block break-words hover:underline">
                  {f.text}
                </Link>
                <p className="flex flex-wrap items-center gap-2 text-xs text-subtle">
                  <StatusBadge status={f.status} />
                  <span>{FACT_KIND_LABELS[f.kind]}</span>
                  <span>·</span>
                  <span>
                    {SOURCE_LABELS[f.source]}
                    {f.sourceDetail ? `: ${f.sourceDetail}` : ""}
                  </span>
                  <span>·</span>
                  <span>{formatDate(f.updatedAt, tz)}</span>
                  {b && !f.gbrainId && f.status !== "withdrawn" ? <span className="badge badge-warn">Not in the brain yet</span> : null}
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-between text-sm">
          {page > 0 ? (
            <Link className="link" href={link({ page: page - 1 })}>
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          {more ? (
            <Link className="link" href={link({ page: page + 1 })}>
              Older →
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  );
}

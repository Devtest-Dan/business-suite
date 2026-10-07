import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import type { ModulePageProps } from "@/lib/modules/contract";
import { correctFactAction, withdrawFactAction } from "../actions";
import { brain } from "../brain";
import { getFact, SOURCE_LABELS } from "../facts";
import { P } from "../ids";
import { FACT_KIND_LABELS, factIdSchema } from "../schemas";
import { StatusBadge } from "./status-badge";

export async function FactPage({ ctx, params, basePath }: ModulePageProps) {
  const id = factIdSchema.safeParse(params.factId);
  if (!id.success) notFound();
  const found = await getFact(ctx.db, id.data);
  if (!found) notFound();
  const { fact, versions } = found;
  const tz = ctx.business.timezone;
  const canCurate = ctx.can(P.curate) && fact.status !== "withdrawn";

  return (
    <article className="max-w-2xl space-y-6">
      <header className="space-y-1">
        <Link href={`${basePath}/facts`} className="link text-sm">
          ← What the assistant knows
        </Link>
        <h1 className="h1">Fact</h1>
      </header>
      <div className="card space-y-3">
        <p className="whitespace-pre-line break-words text-lg leading-relaxed" data-testid="fact-text">
          {fact.text}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-subtle">Status</dt>
          <dd>
            <StatusBadge status={fact.status} /> {fact.status === "active" ? "Current" : null}
            {fact.withdrawnReason ? ` (${fact.withdrawnReason})` : null}
          </dd>
          <dt className="text-subtle">Kind</dt>
          <dd>{FACT_KIND_LABELS[fact.kind]}</dd>
          <dt className="text-subtle">Source</dt>
          <dd>
            {SOURCE_LABELS[fact.source]}
            {fact.sourceDetail ? `: ${fact.sourceDetail}` : ""}
            {fact.sourceUrl ? (
              <>
                {" "}
                <Link className="link" href={fact.sourceUrl}>
                  Open where it came from
                </Link>
              </>
            ) : null}
          </dd>
          <dt className="text-subtle">{fact.status === "corrected" ? "Corrected" : "Added"}</dt>
          <dd>
            {formatDateTime(fact.updatedAt, tz)}
            {fact.createdByName ? ` by ${fact.createdByName}` : ""}
          </dd>
          {brain() ? (
            <>
              <dt className="text-subtle">Brain</dt>
              <dd>{fact.gbrainId ? "In the brain" : fact.status === "withdrawn" ? "Not recalled" : `Not there yet${fact.brainError ? ` (${fact.brainError})` : ""}`}</dd>
            </>
          ) : null}
        </dl>
      </div>

      {canCurate ? (
        <div className="grid gap-4 md:grid-cols-2">
          <ActionForm action={correctFactAction} submit="Save correction" className="card space-y-3">
            <h2 className="h2">Correct it</h2>
            <input type="hidden" name="factId" value={fact.id} />
            <label className="block">
              <span className="label">New wording</span>
              <textarea name="text" required rows={4} maxLength={2000} defaultValue={fact.text} className="input" />
            </label>
            <p className="hint">The old wording is kept below. The assistant and agents recall only the new one.</p>
          </ActionForm>
          <ActionForm action={withdrawFactAction} submit="Withdraw this fact" submitClassName="btn btn-danger" className="card space-y-3">
            <h2 className="h2">Withdraw it</h2>
            <input type="hidden" name="factId" value={fact.id} />
            <label className="block">
              <span className="label">Why (optional)</span>
              <input name="reason" maxLength={300} className="input" />
            </label>
            <p className="hint">The assistant and coding agents stop recalling it. The record stays here, marked withdrawn.</p>
          </ActionForm>
        </div>
      ) : null}

      {versions.length ? (
        <section className="card space-y-2" aria-labelledby="history">
          <h2 id="history" className="h2">
            Earlier wording
          </h2>
          <ul className="space-y-2 text-sm" data-testid="fact-history">
            {versions.map((v) => (
              <li key={v.id}>
                <p className="break-words">{v.text}</p>
                <p className="text-xs text-subtle">
                  {v.byName ? `${v.byName}, ` : ""}
                  {formatDateTime(v.writtenAt, tz)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

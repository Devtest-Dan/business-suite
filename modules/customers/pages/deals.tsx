import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { formatDate } from "@/lib/format";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { deleteDealAction, moveDealAction, saveDealAction } from "../actions";
import {
  filterQueryString,
  formatMoney,
  getDeal,
  listCompanies,
  listContacts,
  listDeals,
  listFields,
  listFollowUps,
  listPeople,
  listSavedFilters,
  listStages,
  P,
  timeline,
  todayIn,
  type DealRow,
  type Stage,
} from "../data";
import { listFilter, type FieldDef } from "../schemas";
import { tasksLink } from "../tasks-link";
import { ExportButton } from "./export-button";
import { ActivityForm, Back, CustomFieldInputs, customRows, DeleteButton, Details, FilterBar, FollowUpForm, FollowUpList, PersonSelect, SavedFilters, Timeline } from "./parts";

const uuid = z.string().uuid();
const CLOSED_SHOWN = 15;

/** The pipeline: one column per stage, in the owner's order. */
export async function DealsPage({ ctx, searchParams, basePath }: ModulePageProps) {
  const filter = listFilter.parse(searchParams);
  const here = `${basePath}/deals`;
  const [stages, deals, people, saved] = await Promise.all([listStages(ctx.db), listDeals(ctx, filter), listPeople(ctx.db), listSavedFilters(ctx, "deals")]);
  const query = filterQueryString(filter as unknown as Record<string, string>).replace(/^\?/, "");
  const canEdit = ctx.can(P.edit);
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Deals</h1>
          <p className="muted">The pipeline, stage by stage. Move a deal with the menu on its card.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ctx.can(P.export) ? <ExportButton entity="deals" query={query} /> : null}
          {ctx.can(P.pipeline) ? (
            <Link href={`${basePath}/settings`} className="btn">
              Edit stages
            </Link>
          ) : null}
          {canEdit ? (
            <Link href={`${here}/new`} className="btn btn-primary">
              <Icon name="plus" className="size-4" /> New deal
            </Link>
          ) : null}
        </div>
      </header>
      <FilterBar action={here} filter={filter} people={people} tags={false} />
      <SavedFilters entity="deals" basePath={here} filters={saved} current={filter} viewerId={ctx.viewer.id} canShare={canEdit} canManageAll={ctx.can(P.pipeline)} />
      <div className="relative -mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" data-testid="pipeline">
        <div className="flex snap-x gap-3">
          {stages.map((stage) => {
            const all = deals.filter((d) => d.stageId === stage.id);
            const shown = stage.kind === "open" ? all : all.slice(0, CLOSED_SHOWN);
            const total = all.reduce((s, d) => s + (d.valueCents ?? 0), 0);
            return (
              <section key={stage.id} className="w-72 shrink-0 snap-start space-y-2 rounded-[var(--radius)] bg-surface-2 p-2" aria-label={stage.name} data-testid={`stage-${stage.name}`}>
                <header className="flex items-baseline justify-between gap-2 px-1">
                  <h2 className="font-semibold">
                    {stage.name} {stage.kind !== "open" ? <span className={`badge ${stage.kind === "won" ? "badge-ok" : "badge-danger"}`}>{stage.kind}</span> : null}
                  </h2>
                  <span className="text-xs text-subtle">
                    {all.length}
                    {total ? ` · ${formatMoney(total)}` : ""}
                  </span>
                </header>
                {shown.length === 0 ? <p className="px-1 text-sm text-subtle">No deals.</p> : null}
                {shown.map((d) => (
                  <DealCard key={d.id} deal={d} stages={stages} canEdit={canEdit} basePath={basePath} tz={ctx.business.timezone} />
                ))}
                {all.length > shown.length ? <p className="px-1 text-xs text-subtle">and {all.length - shown.length} older</p> : null}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DealCard({ deal, stages, canEdit, basePath, tz }: { deal: DealRow; stages: Stage[]; canEdit: boolean; basePath: string; tz: string }) {
  return (
    <article className="card space-y-1 p-3 sm:p-3" data-testid="deal-card">
      <Link href={`${basePath}/deals/${deal.id}`} className="link block font-medium">
        {deal.title}
      </Link>
      <p className="text-xs text-subtle">
        {[deal.contactName, deal.companyName].filter(Boolean).join(" · ")}
        {deal.valueCents !== null ? ` · ${formatMoney(deal.valueCents)}` : ""}
        {deal.expectedClose ? ` · close ${formatDate(`${deal.expectedClose}T12:00:00Z`, tz)}` : ""}
      </p>
      {canEdit ? (
        <ActionForm action={moveDealAction} submit="Move" submitClassName="btn" className="flex items-end gap-2 pt-1">
          <input type="hidden" name="dealId" value={deal.id} />
          <label className="block flex-1">
            <span className="sr-only">Stage for {deal.title}</span>
            <select name="stageId" defaultValue={deal.stageId} className="input">
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </ActionForm>
      ) : null}
    </article>
  );
}

async function DealFields({
  ctx,
  deal,
  prefill,
  fields,
}: {
  ctx: ModulePageProps["ctx"];
  deal: DealRow | null;
  prefill: { contactId?: string; companyId?: string };
  fields: FieldDef[];
}) {
  const [stages, contacts, companies, people] = await Promise.all([listStages(ctx.db), listContacts(ctx, {}, 1000), listCompanies(ctx, {}, 1000), listPeople(ctx.db)]);
  return (
    <>
      {deal ? <input type="hidden" name="id" value={deal.id} /> : null}
      <label className="block">
        <span className="label">Title</span>
        <input name="title" required maxLength={200} defaultValue={deal?.title} className="input" placeholder="e.g. Spring catering contract" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">Stage</span>
          <select name="stageId" defaultValue={deal?.stageId ?? stages[0]?.id} className="input">
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Value</span>
          <input name="value" inputMode="decimal" maxLength={20} defaultValue={deal ? formatMoney(deal.valueCents) : ""} className="input" placeholder="e.g. 1250.00" />
          <span className="hint">In your usual currency. Leave empty if not known yet.</span>
        </label>
        <label className="block">
          <span className="label">Contact</span>
          <select name="contactId" defaultValue={deal?.contactId ?? prefill.contactId ?? ""} className="input">
            <option value="">None</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.companyName ? ` (${c.companyName})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Company</span>
          <select name="companyId" defaultValue={deal?.companyId ?? prefill.companyId ?? ""} className="input">
            <option value="">The contact&apos;s company, if any</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Expected to close</span>
          <input type="date" name="expectedClose" defaultValue={deal?.expectedClose ?? ""} className="input" />
        </label>
        <PersonSelect people={people} name="ownerId" label="Owner" value={deal ? deal.ownerId : ctx.viewer.id} />
      </div>
      <CustomFieldInputs fields={fields} values={deal?.custom ?? {}} />
      <label className="block">
        <span className="label">Notes</span>
        <textarea name="notes" rows={4} maxLength={5000} defaultValue={deal?.notes} className="input" />
        <span className="hint">Never store card numbers here: they are refused.</span>
      </label>
    </>
  );
}

export async function NewDealPage({ ctx, searchParams, basePath }: ModulePageProps) {
  const pick = (v: unknown) => (uuid.safeParse(v).success ? (v as string) : undefined);
  const fields = await listFields(ctx.db, "deal");
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Back href={`${basePath}/deals`} label="Deals" />
        <h1 className="h1">New deal</h1>
      </header>
      <ActionForm action={saveDealAction} submit="Add deal" className="card space-y-4">
        <DealFields ctx={ctx} deal={null} prefill={{ contactId: pick(searchParams.contact), companyId: pick(searchParams.company) }} fields={fields} />
      </ActionForm>
    </div>
  );
}

export async function EditDealPage({ ctx, params, basePath }: ModulePageProps) {
  const id = uuid.safeParse(params.dealId);
  if (!id.success) notFound();
  const [deal, fields] = await Promise.all([getDeal(ctx.db, id.data), listFields(ctx.db, "deal")]);
  if (!deal) notFound();
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Back href={`${basePath}/deals/${deal.id}`} label={deal.title} />
        <h1 className="h1">Edit deal</h1>
      </header>
      <ActionForm action={saveDealAction} submit="Save" className="card space-y-4">
        <DealFields ctx={ctx} deal={deal} prefill={{}} fields={fields} />
      </ActionForm>
    </div>
  );
}

export async function DealPage({ ctx, params, basePath }: ModulePageProps) {
  const id = uuid.safeParse(params.dealId);
  if (!id.success) notFound();
  const deal = await getDeal(ctx.db, id.data);
  if (!deal) notFound();
  const tz = ctx.business.timezone;
  const today = todayIn(tz);
  const [stages, fields, followUps, events, people, tasks] = await Promise.all([
    listStages(ctx.db),
    listFields(ctx.db, "deal"),
    listFollowUps(ctx.db, { dealId: deal.id }),
    timeline(ctx.db, { dealId: deal.id }),
    listPeople(ctx.db),
    tasksLink(),
  ]);
  const canEdit = ctx.can(P.edit);
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Back href={`${basePath}/deals`} label="Deals" />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="h1 break-words">{deal.title}</h1>
            <p className="muted">
              <span className={`badge ${deal.stageKind === "won" ? "badge-ok" : deal.stageKind === "lost" ? "badge-danger" : "badge-accent"}`} data-testid="deal-stage">
                {deal.stageName}
              </span>
              {deal.valueCents !== null ? ` · ${formatMoney(deal.valueCents)}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit ? (
              <Link className="btn" href={`${basePath}/deals/${deal.id}/edit`}>
                Edit
              </Link>
            ) : null}
            {ctx.can(P.delete) ? <DeleteButton action={deleteDealAction.bind(null, deal.id)} what={`the deal ${deal.title} and its timeline`} /> : null}
          </div>
        </div>
      </header>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="space-y-6">
          {canEdit ? (
            <section className="card space-y-2" aria-label="Stage">
              <ActionForm action={moveDealAction} submit="Move" submitClassName="btn" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="dealId" value={deal.id} />
                <label className="block flex-1">
                  <span className="label">Stage</span>
                  <select name="stageId" defaultValue={deal.stageId} className="input">
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              </ActionForm>
            </section>
          ) : null}
          <section className="card space-y-3" aria-labelledby="details">
            <h2 id="details" className="h2">
              Details
            </h2>
            <Details
              rows={[
                ["Contact", deal.contactId ? <Link className="link" href={`${basePath}/contacts/${deal.contactId}`}>{deal.contactName}</Link> : ""],
                ["Company", deal.companyId ? <Link className="link" href={`${basePath}/companies/${deal.companyId}`}>{deal.companyName}</Link> : ""],
                ["Expected to close", deal.expectedClose ? formatDate(`${deal.expectedClose}T12:00:00Z`, tz) : ""],
                ["Closed", deal.closedAt ? formatDate(deal.closedAt, tz) : ""],
                ["Owner", deal.ownerName ?? ""],
                ...customRows(fields, deal.custom),
                ["Notes", deal.notes],
              ]}
            />
          </section>
          <section className="card space-y-3" aria-labelledby="follow-ups">
            <h2 id="follow-ups" className="h2">
              Follow-ups
            </h2>
            <FollowUpList items={followUps} tz={tz} today={today} canEdit={canEdit} />
            {canEdit ? (
              <details>
                <summary className="link cursor-pointer text-sm">Set a follow-up</summary>
                <div className="mt-3">
                  <FollowUpForm subject={{ dealId: deal.id }} people={people} viewerId={ctx.viewer.id} today={today} tasksOn={Boolean(tasks)} />
                </div>
              </details>
            ) : null}
          </section>
        </div>
        <section className="card space-y-4" aria-labelledby="timeline">
          <h2 id="timeline" className="h2">
            Timeline
          </h2>
          {canEdit ? <ActivityForm subject={{ dealId: deal.id }} today={today} /> : null}
          <Timeline entries={events} tz={tz} showDeal={false} />
        </section>
      </div>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { deleteCompanyAction, saveCompanyAction } from "../actions";
import {
  contactsOfCompany,
  filterQueryString,
  formatMoney,
  getCompany,
  listCompanies,
  listDeals,
  listFields,
  listFollowUps,
  listPeople,
  listSavedFilters,
  P,
  timeline,
  todayIn,
  type Company,
} from "../data";
import { listFilter, type FieldDef } from "../schemas";
import { tasksLink } from "../tasks-link";
import { ExportButton } from "./export-button";
import { ActivityForm, Back, CustomFieldInputs, customRows, DeleteButton, Details, FilterBar, FollowUpForm, FollowUpList, PersonSelect, SavedFilters, Tags, Timeline } from "./parts";

const uuid = z.string().uuid();

export async function CompaniesPage({ ctx, searchParams, basePath }: ModulePageProps) {
  const filter = listFilter.parse(searchParams);
  const here = `${basePath}/companies`;
  const [companies, people, saved] = await Promise.all([listCompanies(ctx, filter), listPeople(ctx.db), listSavedFilters(ctx, "companies")]);
  const query = filterQueryString(filter as unknown as Record<string, string>).replace(/^\?/, "");
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Companies</h1>
          <p className="muted">Businesses and organisations, with their people and deals.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ctx.can(P.export) ? <ExportButton entity="companies" query={query} /> : null}
          {ctx.can(P.edit) ? (
            <Link href={`${here}/new`} className="btn btn-primary">
              <Icon name="plus" className="size-4" /> New company
            </Link>
          ) : null}
        </div>
      </header>
      <FilterBar action={here} filter={filter} people={people} />
      <SavedFilters entity="companies" basePath={here} filters={saved} current={filter} viewerId={ctx.viewer.id} canShare={ctx.can(P.edit)} canManageAll={ctx.can(P.pipeline)} />
      {companies.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">{query ? "No company matches this filter." : "No companies yet."}</p>
          <p className="muted">{query ? "Change or clear the filter." : "Companies are added here, or when you give a contact a company name."}</p>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0 sm:p-0">
          <table className="table" data-testid="company-list">
            <thead>
              <tr>
                <th>Name</th>
                <th className="w-24">People</th>
                <th className="hidden md:table-cell">Contact details</th>
                <th className="hidden lg:table-cell">Tags</th>
                <th className="hidden md:table-cell">Owner</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`${here}/${c.id}`} className="link font-medium">
                      {c.name}
                    </Link>
                    {c.website ? <span className="block break-all text-xs text-subtle">{c.website}</span> : null}
                  </td>
                  <td>{c.contactCount}</td>
                  <td className="hidden md:table-cell">
                    <span className="block break-all">{c.email}</span>
                    <span className="block text-subtle">{c.phone}</span>
                  </td>
                  <td className="hidden lg:table-cell">
                    <Tags tags={c.tags} basePath={here} />
                  </td>
                  <td className="hidden md:table-cell text-subtle">{c.ownerName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CompanyFields({ company, people, fields, viewerId }: { company: Company | null; people: { id: string; name: string }[]; fields: FieldDef[]; viewerId: string }) {
  return (
    <>
      {company ? <input type="hidden" name="id" value={company.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">Name</span>
          <input name="name" required maxLength={160} defaultValue={company?.name} className="input" />
        </label>
        <label className="block">
          <span className="label">Website</span>
          <input name="website" maxLength={300} defaultValue={company?.website} className="input" />
        </label>
        <label className="block">
          <span className="label">Email</span>
          <input name="email" type="email" maxLength={254} defaultValue={company?.email} className="input" />
        </label>
        <label className="block">
          <span className="label">Phone</span>
          <input name="phone" type="tel" maxLength={40} defaultValue={company?.phone} className="input" />
        </label>
        <PersonSelect people={people} name="ownerId" label="Owner" value={company ? company.ownerId : viewerId} />
        <label className="block">
          <span className="label">Tags</span>
          <input name="tags" maxLength={800} defaultValue={company?.tags.join(", ")} className="input" />
          <span className="hint">Separate tags with commas.</span>
        </label>
      </div>
      <label className="block">
        <span className="label">Address</span>
        <textarea name="address" rows={2} maxLength={500} defaultValue={company?.address} className="input" />
      </label>
      <CustomFieldInputs fields={fields} values={company?.custom ?? {}} />
      <label className="block">
        <span className="label">Notes</span>
        <textarea name="notes" rows={4} maxLength={5000} defaultValue={company?.notes} className="input" />
        <span className="hint">Never store card numbers here: they are refused.</span>
      </label>
    </>
  );
}

export async function NewCompanyPage({ ctx, basePath }: ModulePageProps) {
  const [people, fields] = await Promise.all([listPeople(ctx.db), listFields(ctx.db, "company")]);
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Back href={`${basePath}/companies`} label="Companies" />
        <h1 className="h1">New company</h1>
      </header>
      <ActionForm action={saveCompanyAction} submit="Add company" className="card space-y-4">
        <CompanyFields company={null} people={people} fields={fields} viewerId={ctx.viewer.id} />
      </ActionForm>
    </div>
  );
}

export async function EditCompanyPage({ ctx, params, basePath }: ModulePageProps) {
  const id = uuid.safeParse(params.companyId);
  if (!id.success) notFound();
  const [company, people, fields] = await Promise.all([getCompany(ctx.db, id.data), listPeople(ctx.db), listFields(ctx.db, "company")]);
  if (!company) notFound();
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Back href={`${basePath}/companies/${company.id}`} label={company.name} />
        <h1 className="h1">Edit company</h1>
      </header>
      <ActionForm action={saveCompanyAction} submit="Save" className="card space-y-4">
        <CompanyFields company={company} people={people} fields={fields} viewerId={ctx.viewer.id} />
      </ActionForm>
    </div>
  );
}

export async function CompanyPage({ ctx, params, basePath }: ModulePageProps) {
  const id = uuid.safeParse(params.companyId);
  if (!id.success) notFound();
  const company = await getCompany(ctx.db, id.data);
  if (!company) notFound();
  const tz = ctx.business.timezone;
  const today = todayIn(tz);
  const [fields, contacts, deals, followUps, events, everyone, tasks] = await Promise.all([
    listFields(ctx.db, "company"),
    contactsOfCompany(ctx.db, company.id),
    listDeals(ctx, { companyId: company.id }),
    listFollowUps(ctx.db, { companyId: company.id }),
    timeline(ctx.db, { companyId: company.id }),
    listPeople(ctx.db),
    tasksLink(),
  ]);
  const canEdit = ctx.can(P.edit);
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Back href={`${basePath}/companies`} label="Companies" />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="h1 break-words">{company.name}</h1>
            <Tags tags={company.tags} basePath={`${basePath}/companies`} />
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit ? (
              <>
                <Link className="btn" href={`${basePath}/deals/new?company=${company.id}`}>
                  New deal
                </Link>
                <Link className="btn" href={`${basePath}/companies/${company.id}/edit`}>
                  Edit
                </Link>
              </>
            ) : null}
            {ctx.can(P.delete) ? <DeleteButton action={deleteCompanyAction.bind(null, company.id)} what={`${company.name} (its contacts are kept)`} /> : null}
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="space-y-6">
          <section className="card space-y-3" aria-labelledby="details">
            <h2 id="details" className="h2">
              Details
            </h2>
            <Details
              rows={[
                ["Website", company.website],
                ["Email", company.email ? <a className="link break-all" href={`mailto:${company.email}`}>{company.email}</a> : ""],
                ["Phone", company.phone ? <a className="link" href={`tel:${company.phone.replace(/[^\d+]/g, "")}`}>{company.phone}</a> : ""],
                ["Address", company.address],
                ["Owner", company.ownerName ?? ""],
                ...customRows(fields, company.custom),
                ["Notes", company.notes],
              ]}
            />
          </section>
          <section className="card space-y-3" aria-labelledby="people">
            <h2 id="people" className="h2">
              People
            </h2>
            {contacts.length === 0 ? (
              <p className="muted text-sm">No contacts at {company.name} yet. Give a contact this company name to add them.</p>
            ) : (
              <ul className="space-y-1 text-sm" data-testid="company-people">
                {contacts.map((c) => (
                  <li key={c.id}>
                    <Link className="link" href={`${basePath}/contacts/${c.id}`}>
                      {c.name}
                    </Link>
                    {c.jobTitle ? <span className="text-subtle"> · {c.jobTitle}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card space-y-3" aria-labelledby="deals">
            <h2 id="deals" className="h2">
              Deals
            </h2>
            {deals.length === 0 ? (
              <p className="muted text-sm">No deals yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {deals.map((d) => (
                  <li key={d.id} className="flex flex-wrap justify-between gap-2">
                    <Link className="link" href={`${basePath}/deals/${d.id}`}>
                      {d.title}
                    </Link>
                    <span className="text-subtle">
                      {d.stageName}
                      {d.valueCents !== null ? ` · ${formatMoney(d.valueCents)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
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
                  <FollowUpForm subject={{ companyId: company.id }} people={everyone} viewerId={ctx.viewer.id} today={today} tasksOn={Boolean(tasks)} />
                </div>
              </details>
            ) : null}
          </section>
        </div>
        <section className="card space-y-4" aria-labelledby="timeline">
          <h2 id="timeline" className="h2">
            Timeline
          </h2>
          <p className="muted text-sm">Everything logged for {company.name}, its people and its deals.</p>
          {canEdit ? <ActivityForm subject={{ companyId: company.id }} today={today} /> : null}
          <Timeline entries={events} tz={tz} showDeal />
        </section>
      </div>
    </div>
  );
}

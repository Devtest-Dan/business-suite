import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { deleteContactAction, saveContactAction } from "../actions";
import {
  filterQueryString,
  getContact,
  listContacts,
  listDeals,
  listFields,
  listFollowUps,
  listPeople,
  listSavedFilters,
  P,
  timeline,
  todayIn,
  formatMoney,
  type ContactRow,
} from "../data";
import { listFilter, type FieldDef } from "../schemas";
import { tasksLink } from "../tasks-link";
import { ExportButton } from "./export-button";
import { ActivityForm, Back, CustomFieldInputs, customRows, DeleteButton, Details, FilterBar, FollowUpForm, FollowUpList, PersonSelect, SavedFilters, Tags, Timeline } from "./parts";

const uuid = z.string().uuid();

export async function ContactsPage({ ctx, searchParams, basePath }: ModulePageProps) {
  const filter = listFilter.parse(searchParams);
  const [contacts, people, saved] = await Promise.all([listContacts(ctx, filter), listPeople(ctx.db), listSavedFilters(ctx, "contacts")]);
  const query = filterQueryString(filter as unknown as Record<string, string>).replace(/^\?/, "");
  const filtered = Boolean(query);
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Contacts</h1>
          <p className="muted">The people {ctx.business.name} sells to and works with.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ctx.can(P.pipeline) ? (
            <Link href={`${basePath}/settings`} className="btn">
              Pipeline and fields
            </Link>
          ) : null}
          {ctx.can(P.export) ? <ExportButton entity="contacts" query={query} /> : null}
          {ctx.can(P.import) ? (
            <Link href={`${basePath}/import`} className="btn">
              Import
            </Link>
          ) : null}
          {ctx.can(P.edit) ? (
            <Link href={`${basePath}/new`} className="btn btn-primary">
              <Icon name="plus" className="size-4" /> New contact
            </Link>
          ) : null}
        </div>
      </header>
      <FilterBar action={basePath} filter={filter} people={people} />
      <SavedFilters entity="contacts" basePath={basePath} filters={saved} current={filter} viewerId={ctx.viewer.id} canShare={ctx.can(P.edit)} canManageAll={ctx.can(P.pipeline)} />
      {contacts.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">{filtered ? "No contact matches this filter." : "No contacts yet."}</p>
          <p className="muted">{filtered ? "Change or clear the filter." : ctx.can(P.edit) ? "Add one with “New contact”, or import a CSV." : "When someone adds one, it shows up here."}</p>
        </div>
      ) : (
        <ContactTable contacts={contacts} basePath={basePath} />
      )}
      {contacts.length >= 200 ? <p className="muted text-sm">Showing the first 200. Narrow the filter to see the rest.</p> : null}
    </div>
  );
}

function ContactTable({ contacts, basePath }: { contacts: ContactRow[]; basePath: string }) {
  return (
    <div className="card overflow-x-auto p-0 sm:p-0">
      <table className="table" data-testid="contact-list">
        <thead>
          <tr>
            <th>Name</th>
            <th className="hidden sm:table-cell">Company</th>
            <th className="hidden md:table-cell">Email and phone</th>
            <th className="hidden lg:table-cell">Tags</th>
            <th className="hidden md:table-cell">Owner</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c) => (
            <tr key={c.id}>
              <td>
                <Link href={`${basePath}/contacts/${c.id}`} className="link font-medium">
                  {c.name}
                </Link>
                {c.jobTitle ? <span className="block text-xs text-subtle">{c.jobTitle}</span> : null}
                <span className="block text-xs text-subtle sm:hidden">{c.companyName}</span>
              </td>
              <td className="hidden sm:table-cell">
                {c.companyId ? (
                  <Link href={`${basePath}/companies/${c.companyId}`} className="link">
                    {c.companyName}
                  </Link>
                ) : null}
              </td>
              <td className="hidden md:table-cell">
                <span className="block break-all">{c.email}</span>
                <span className="block text-subtle">{c.phone}</span>
              </td>
              <td className="hidden lg:table-cell">
                <Tags tags={c.tags} basePath={basePath} />
              </td>
              <td className="hidden md:table-cell text-subtle">{c.ownerName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContactFields({ contact, people, fields, viewerId }: { contact: ContactRow | null; people: { id: string; name: string }[]; fields: FieldDef[]; viewerId: string }) {
  return (
    <>
      {contact ? <input type="hidden" name="id" value={contact.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">Name</span>
          <input name="name" required maxLength={160} defaultValue={contact?.name} className="input" />
        </label>
        <label className="block">
          <span className="label">Company</span>
          <input name="companyName" maxLength={160} defaultValue={contact?.companyName ?? ""} className="input" />
          <span className="hint">Type a company name: an existing one is used, or a new one is added.</span>
        </label>
        <label className="block">
          <span className="label">Email</span>
          <input name="email" type="email" maxLength={254} defaultValue={contact?.email} className="input" />
        </label>
        <label className="block">
          <span className="label">Phone</span>
          <input name="phone" type="tel" maxLength={40} defaultValue={contact?.phone} className="input" />
        </label>
        <label className="block">
          <span className="label">Job title</span>
          <input name="jobTitle" maxLength={120} defaultValue={contact?.jobTitle} className="input" />
        </label>
        <PersonSelect people={people} name="ownerId" label="Owner" value={contact ? contact.ownerId : viewerId} />
      </div>
      <label className="block">
        <span className="label">Address</span>
        <textarea name="address" rows={2} maxLength={500} defaultValue={contact?.address} className="input" />
      </label>
      <label className="block">
        <span className="label">Tags</span>
        <input name="tags" maxLength={800} defaultValue={contact?.tags.join(", ")} className="input" placeholder="e.g. vip, wholesale" />
        <span className="hint">Separate tags with commas.</span>
      </label>
      <CustomFieldInputs fields={fields} values={contact?.custom ?? {}} />
      <label className="block">
        <span className="label">Notes</span>
        <textarea name="notes" rows={4} maxLength={5000} defaultValue={contact?.notes} className="input" />
        <span className="hint">Never store card numbers here: they are refused. Card details belong with your payment provider.</span>
      </label>
    </>
  );
}

export async function NewContactPage({ ctx, basePath }: ModulePageProps) {
  const [people, fields] = await Promise.all([listPeople(ctx.db), listFields(ctx.db, "contact")]);
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Back href={basePath} label="Contacts" />
        <h1 className="h1">New contact</h1>
      </header>
      <ActionForm action={saveContactAction} submit="Add contact" className="card space-y-4">
        <ContactFields contact={null} people={people} fields={fields} viewerId={ctx.viewer.id} />
      </ActionForm>
    </div>
  );
}

export async function EditContactPage({ ctx, params, basePath }: ModulePageProps) {
  const id = uuid.safeParse(params.contactId);
  if (!id.success) notFound();
  const [contact, people, fields] = await Promise.all([getContact(ctx.db, id.data), listPeople(ctx.db), listFields(ctx.db, "contact")]);
  if (!contact) notFound();
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Back href={`${basePath}/contacts/${contact.id}`} label={contact.name} />
        <h1 className="h1">Edit contact</h1>
      </header>
      <ActionForm action={saveContactAction} submit="Save" className="card space-y-4">
        <ContactFields contact={contact} people={people} fields={fields} viewerId={ctx.viewer.id} />
      </ActionForm>
    </div>
  );
}

export async function ContactPage({ ctx, params, basePath }: ModulePageProps) {
  const id = uuid.safeParse(params.contactId);
  if (!id.success) notFound();
  const contact = await getContact(ctx.db, id.data);
  if (!contact) notFound();
  const tz = ctx.business.timezone;
  const today = todayIn(tz);
  const [fields, deals, followUps, events, people, tasks] = await Promise.all([
    listFields(ctx.db, "contact"),
    listDeals(ctx, { contactId: contact.id }),
    listFollowUps(ctx.db, { contactId: contact.id }),
    timeline(ctx.db, { contactId: contact.id }),
    listPeople(ctx.db),
    tasksLink(),
  ]);
  const canEdit = ctx.can(P.edit);
  const open = followUps.filter((f) => f.status === "open");
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Back href={basePath} label="Contacts" />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="h1 break-words">{contact.name}</h1>
            <p className="muted">
              {[contact.jobTitle, contact.companyName].filter(Boolean).join(" at ")}
              {contact.companyId ? (
                <>
                  {" · "}
                  <Link className="link" href={`${basePath}/companies/${contact.companyId}`}>
                    company
                  </Link>
                </>
              ) : null}
            </p>
            <Tags tags={contact.tags} basePath={basePath} />
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit ? (
              <>
                <Link className="btn" href={`${basePath}/deals/new?contact=${contact.id}`}>
                  New deal
                </Link>
                <Link className="btn" href={`${basePath}/contacts/${contact.id}/edit`}>
                  Edit
                </Link>
              </>
            ) : null}
            {ctx.can(P.delete) ? <DeleteButton action={deleteContactAction.bind(null, contact.id)} what={`${contact.name} and their timeline`} /> : null}
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
                ["Email", contact.email ? <a className="link break-all" href={`mailto:${contact.email}`}>{contact.email}</a> : ""],
                ["Phone", contact.phone ? <a className="link" href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}>{contact.phone}</a> : ""],
                ["Address", contact.address],
                ["Owner", contact.ownerName ?? ""],
                ...customRows(fields, contact.custom),
                ["Notes", contact.notes],
              ]}
            />
          </section>

          <section className="card space-y-3" aria-labelledby="follow-ups">
            <h2 id="follow-ups" className="h2">
              Follow-ups {open.length ? <span className="badge">{open.length} open</span> : null}
            </h2>
            <FollowUpList items={followUps} tz={tz} today={today} canEdit={canEdit} />
            {canEdit ? (
              <details>
                <summary className="link cursor-pointer text-sm">Set a follow-up</summary>
                <div className="mt-3">
                  <FollowUpForm subject={{ contactId: contact.id }} people={people} viewerId={ctx.viewer.id} today={today} tasksOn={Boolean(tasks)} />
                </div>
              </details>
            ) : null}
          </section>

          <section className="card space-y-3" aria-labelledby="deals">
            <h2 id="deals" className="h2">
              Deals
            </h2>
            {deals.length === 0 ? (
              <p className="muted text-sm">No deals with {contact.name} yet.</p>
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
        </div>

        <section className="card space-y-4" aria-labelledby="timeline">
          <h2 id="timeline" className="h2">
            Timeline
          </h2>
          {canEdit ? <ActivityForm subject={{ contactId: contact.id }} today={today} /> : null}
          <Timeline entries={events} tz={tz} />
        </section>
      </div>
    </div>
  );
}

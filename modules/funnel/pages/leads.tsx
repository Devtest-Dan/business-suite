import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { addLeadAction, assignAction, convertAction, deleteLeadAction, enrollAction, logContactAction, markRepliedAction, setStatusAction } from "../actions";
import { customerContactUrl, customerDealUrl, customersInstalled, customersLink, CUSTOMERS_OFF, settleConversion } from "../convert";
import { getLead, getSettings, leadEvents, listLeads, listPeople, P, waiting, type LeadRow } from "../data";
import {
  CONTACT_KIND_LABELS,
  CONTACT_KINDS,
  CONTACT_METHOD_LABELS,
  CONTACT_METHODS,
  DISQUALIFY_REASONS,
  MANUAL_SOURCES,
  SOURCE_LABELS,
  STATUS_LABELS,
  STATUSES,
  type LeadSource,
} from "../logic";
import { leadListFilter } from "../schemas";
import { enrollmentsOfLead, kickDueEmails, listSequences } from "../sequences";
import { Back, PersonSelect, Speed, StatusBadge, SubNav } from "./parts";

export async function LeadsPage({ ctx, searchParams, basePath }: ModulePageProps) {
  kickDueEmails();
  const filter = leadListFilter.parse(searchParams);
  const [leads, settings, sequences] = await Promise.all([listLeads(ctx, filter), getSettings(ctx.db), ctx.can(P.work) ? listSequences(ctx.db) : Promise.resolve([])]);
  const active = sequences.filter((s) => s.active);
  const canEnroll = ctx.can(P.work) && active.length > 0;
  const filtered = Boolean(filter.q || filter.who || filter.source || filter.status !== "open");
  const table = <LeadTable leads={leads} basePath={basePath} target={settings.targetMinutes} selectable={canEnroll} timeZone={ctx.business.timezone} />;
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Leads</h1>
          <p className="muted">People who asked {ctx.business.name} about its work. Call back the oldest new ones first: your target is {settings.targetMinutes} min.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ctx.can(P.import) ? (
            <Link href={`${basePath}/import`} className="btn">
              Import
            </Link>
          ) : null}
          {ctx.can(P.work) ? (
            <Link href={`${basePath}/new`} className="btn btn-primary">
              <Icon name="plus" className="size-4" /> Add lead
            </Link>
          ) : null}
        </div>
      </header>
      <SubNav basePath={basePath} current="" canManage={ctx.can(P.manage)} />
      <form method="get" action={basePath} className="card flex flex-wrap items-end gap-3" role="search">
        <label className="block min-w-48 flex-1">
          <span className="label">Search</span>
          <input name="q" defaultValue={filter.q} className="input" placeholder="Name, email, phone or a word" />
        </label>
        <label className="block">
          <span className="label">Status</span>
          <select name="status" defaultValue={filter.status} className="input">
            <option value="open">Open (new, contacted, qualified)</option>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Who</span>
          <select name="who" defaultValue={filter.who} className="input">
            <option value="">Everyone</option>
            <option value="me">Mine</option>
            <option value="unassigned">Nobody assigned</option>
          </select>
        </label>
        <label className="block">
          <span className="label">Source</span>
          <select name="source" defaultValue={filter.source} className="input">
            <option value="">Any</option>
            {(Object.keys(SOURCE_LABELS) as LeadSource[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn">
          Filter
        </button>
        {filtered ? (
          <Link href={basePath} className="link text-sm">
            Clear
          </Link>
        ) : null}
      </form>
      {leads.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">{filtered ? "No lead matches this filter." : "No open leads."}</p>
          <p className="muted">{filtered ? "Change or clear the filter." : ctx.can(P.manage) ? "Make a form under Forms and put it on your website, or add a lead by hand." : "New leads from the website and the phone show up here."}</p>
        </div>
      ) : canEnroll ? (
        <ActionForm action={enrollAction} submit="Send for approval" className="space-y-3" submitClassName="btn">
          {table}
          <div className="card flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="label">Send the ticked leads an email sequence</span>
              <select name="sequenceId" className="input" required>
                {active.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.steps} email{s.steps === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            </label>
            <p className="hint w-full">This makes one approval for all of them. Nothing is sent until it is approved.</p>
          </div>
        </ActionForm>
      ) : (
        table
      )}
      {leads.length >= 200 ? <p className="muted text-sm">Showing the first 200. Narrow the filter to see the rest.</p> : null}
    </div>
  );
}

function LeadTable({ leads, basePath, target, selectable, timeZone }: { leads: LeadRow[]; basePath: string; target: number; selectable: boolean; timeZone: string }) {
  return (
    <div className="card overflow-x-auto p-0 sm:p-0">
      <table className="table" data-testid="lead-list">
        <thead>
          <tr>
            {selectable ? (
              <th className="w-8">
                <span className="sr-only">Pick</span>
              </th>
            ) : null}
            <th>Lead</th>
            <th>Status</th>
            <th className="hidden sm:table-cell">Speed to lead</th>
            <th className="hidden md:table-cell">Source</th>
            <th className="hidden md:table-cell">Assigned to</th>
            <th className="hidden lg:table-cell">Received</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => {
            const w = waiting(l, target);
            return (
              <tr key={l.id}>
                {selectable ? (
                  <td>
                    <input type="checkbox" name="leadId" value={l.id} aria-label={`Pick ${l.name}`} />
                  </td>
                ) : null}
                <td>
                  <Link href={`${basePath}/leads/${l.id}`} className="link font-medium">
                    {l.name}
                  </Link>
                  {l.service ? <span className="block text-xs text-subtle">{l.service}</span> : null}
                  <span className="block text-xs sm:hidden">
                    <Speed {...w} target={target} />
                  </span>
                </td>
                <td>
                  <StatusBadge status={l.status} />
                </td>
                <td className="hidden sm:table-cell">
                  <Speed {...w} target={target} />
                </td>
                <td className="hidden md:table-cell text-subtle">
                  {SOURCE_LABELS[l.source as LeadSource]}
                  {l.sourceDetail ? <span className="block text-xs">{l.sourceDetail}</span> : null}
                </td>
                <td className="hidden md:table-cell text-subtle">{l.assigneeName ?? "Nobody"}</td>
                <td className="hidden lg:table-cell text-subtle">{formatDateTime(l.createdAt, timeZone)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export async function NewLeadPage({ ctx, basePath }: ModulePageProps) {
  const people = await listPeople(ctx.db);
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Back href={basePath} label="Leads" />
        <h1 className="h1">Add a lead</h1>
        <p className="muted">Someone called, walked in or was sent by a customer. Leads from your website forms arrive by themselves.</p>
      </header>
      <ActionForm action={addLeadAction} submit="Add lead" className="card space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">Name</span>
            <input name="name" required maxLength={160} className="input" />
          </label>
          <label className="block">
            <span className="label">Company</span>
            <input name="company" maxLength={160} className="input" />
          </label>
          <label className="block">
            <span className="label">Email</span>
            <input name="email" type="email" maxLength={254} className="input" />
          </label>
          <label className="block">
            <span className="label">Phone</span>
            <input name="phone" type="tel" maxLength={40} className="input" />
          </label>
          <label className="block">
            <span className="label">How they reached you</span>
            <select name="source" className="input" defaultValue="phone">
              {MANUAL_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Source detail</span>
            <input name="sourceDetail" maxLength={200} className="input" placeholder="e.g. saw the van, referred by Ana" />
          </label>
          <label className="block">
            <span className="label">Service wanted</span>
            <input name="service" maxLength={120} className="input" />
          </label>
          <label className="block">
            <span className="label">Preferred contact method</span>
            <select name="contactMethod" className="input" defaultValue="">
              <option value="">No preference</option>
              {CONTACT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {CONTACT_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <PersonSelect people={people} name="assigneeId" label="Assign to" value={ctx.viewer.id} />
        </div>
        <label className="block">
          <span className="label">Notes</span>
          <textarea name="message" rows={4} maxLength={3000} className="input" />
          <span className="hint">Never write card numbers here: they are refused.</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="alreadyContacted" defaultChecked />
          <span>I already spoke with them (the first contact is now)</span>
        </label>
      </ActionForm>
    </div>
  );
}

export async function LeadPage({ ctx, params, basePath }: ModulePageProps) {
  let lead = await getLead(ctx.db, params.leadId ?? "");
  if (!lead) notFound();
  if (lead.conversionApprovalId && !lead.customerDealId) {
    await settleConversion(ctx, lead);
    lead = (await getLead(ctx.db, lead.id))!;
  }
  kickDueEmails();
  const [settings, events, people, enrollments, sequences, link] = await Promise.all([
    getSettings(ctx.db),
    leadEvents(ctx.db, lead.id),
    listPeople(ctx.db),
    enrollmentsOfLead(ctx.db, lead.id),
    listSequences(ctx.db),
    customersLink(),
  ]);
  const w = waiting(lead, settings.targetMinutes);
  const tz = ctx.business.timezone;
  const canWork = ctx.can(P.work);
  const open = lead.status !== "converted";
  const active = sequences.filter((s) => s.active && !enrollments.some((e) => e.sequenceId === s.id));
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Back href={basePath} label="Leads" />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="h1">{lead.name}</h1>
          <StatusBadge status={lead.status} />
        </div>
        <p data-testid="lead-speed">
          <Speed {...w} target={settings.targetMinutes} />
          {w.over ? <span className="text-danger"> · over your {settings.targetMinutes}-minute target</span> : null}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="card min-w-0 space-y-3" aria-labelledby="details">
          <h2 className="h2" id="details">
            Details
          </h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <Row label="Email" value={lead.email} />
            <Row label="Phone" value={lead.phone} />
            <Row label="Company" value={lead.company} />
            <Row label="Service" value={lead.service} />
            <Row label="Prefers" value={lead.contactMethod ? CONTACT_METHOD_LABELS[lead.contactMethod as keyof typeof CONTACT_METHOD_LABELS] : ""} />
            <Row label="Source" value={`${SOURCE_LABELS[lead.source as LeadSource]}${lead.sourceDetail ? `: ${lead.sourceDetail}` : ""}`} />
            <Row label="Page" value={lead.pageUrl} />
            <Row label="Referrer" value={lead.referrer} />
            <Row label="Campaign" value={[lead.utmSource && `utm_source ${lead.utmSource}`, lead.utmMedium && `utm_medium ${lead.utmMedium}`, lead.utmCampaign && `utm_campaign ${lead.utmCampaign}`].filter(Boolean).join(", ")} />
            <Row label="Received" value={formatDateTime(lead.createdAt, tz)} />
            <Row label="Assigned to" value={lead.assigneeName ?? "Nobody"} />
            {lead.status === "disqualified" ? <Row label="Why" value={lead.disqualifyReason} /> : null}
            {lead.unsubscribedAt ? <Row label="Emails" value={`Unsubscribed ${formatDateTime(lead.unsubscribedAt, tz)}`} /> : null}
          </dl>
          {lead.message ? <p className="whitespace-pre-line rounded-md bg-surface-2 p-3 text-sm [overflow-wrap:anywhere]">{lead.message}</p> : null}
          {lead.consentText ? (
            <p className="hint">
              Ticked on {formatDateTime(lead.consentAt, tz)}: “{lead.consentText}”
            </p>
          ) : null}
          {lead.customerDealId ? (
            <div className="notice notice-ok text-sm" data-testid="lead-converted">
              <p>
                In Customers:{" "}
                {lead.customerContactId ? (
                  <Link className="link" href={customerContactUrl(lead.customerContactId)}>
                    the contact
                  </Link>
                ) : null}
                {lead.customerContactId ? " and " : ""}
                <Link className="link" href={customerDealUrl(lead.customerDealId)}>
                  the deal
                </Link>
                .
              </p>
            </div>
          ) : null}
        </section>

        <section className="min-w-0 space-y-4" aria-label="Work this lead">
          {canWork && open ? (
            <>
              <ActionForm action={logContactAction} submit="Log it" className="card space-y-3" resetOnSuccess>
                <h2 className="h2">Log a contact</h2>
                <input type="hidden" name="leadId" value={lead.id} />
                <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
                  <label className="block">
                    <span className="label">What you did</span>
                    <select name="kind" className="input" defaultValue="call">
                      {CONTACT_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {CONTACT_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="label">Note</span>
                    <input name="note" maxLength={2000} className="input" placeholder="What was said, what is next" />
                  </label>
                </div>
              </ActionForm>
              <div className="grid gap-4 sm:grid-cols-2">
                <ActionForm action={setStatusAction} submit="Change status" className="card space-y-3">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <label className="block">
                    <span className="label">Status</span>
                    <select name="status" className="input" defaultValue={lead.status}>
                      {(["new", "contacted", "qualified", "disqualified"] as const).map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="label">If disqualified, why</span>
                    <select name="reason" className="input" defaultValue="">
                      <option value="">—</option>
                      {DISQUALIFY_REASONS.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </label>
                  <input name="reasonDetail" maxLength={300} className="input" placeholder="More detail (optional)" aria-label="More detail" />
                </ActionForm>
                <ActionForm action={assignAction} submit="Assign" className="card space-y-3">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <PersonSelect people={people} name="assigneeId" label="Assigned to" value={lead.assigneeId} />
                </ActionForm>
              </div>
              <div className="card space-y-3">
                <h2 className="h2">Make them a customer</h2>
                {link ? (
                  <ActionForm action={convertAction} submit="Convert to customer" submitClassName="btn btn-primary">
                    <input type="hidden" name="leadId" value={lead.id} />
                    <p className="hint">Adds the contact (or merges into one with the same email, phone or name) and a deal in the first open stage of Customers, with this lead&apos;s source in its notes.</p>
                  </ActionForm>
                ) : (
                  <p className="notice notice-warn text-sm">{customersInstalled() ? CUSTOMERS_OFF : "Customers is not installed in this suite, so a lead cannot be converted here."}</p>
                )}
              </div>
              <div className="card space-y-3">
                <h2 className="h2">Follow-up emails</h2>
                {enrollments.length ? (
                  <ul className="space-y-1 text-sm" data-testid="lead-enrollments">
                    {enrollments.map((e) => (
                      <li key={e.id}>
                        “{e.sequenceName}”: {e.sent} of {e.total} sent ·{" "}
                        {e.status === "active" ? (e.nextAt ? `next ${formatDateTime(new Date(e.nextAt), tz)}` : "sending") : e.status === "finished" ? "finished" : `stopped (${e.stopReason})`}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {active.length && lead.email && !lead.unsubscribedAt && (lead.status === "new" || lead.status === "qualified") ? (
                  <ActionForm action={enrollAction} submit="Send for approval" submitClassName="btn">
                    <input type="hidden" name="leadId" value={lead.id} />
                    <label className="block">
                      <span className="label">Sequence</span>
                      <select name="sequenceId" className="input">
                        {active.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </ActionForm>
                ) : (
                  <p className="hint">
                    {lead.unsubscribedAt
                      ? "They unsubscribed: no sequence emails."
                      : !lead.email
                        ? "No email address, so no sequence emails."
                        : lead.status !== "new" && lead.status !== "qualified"
                          ? "Sequences are for new and qualified leads nobody is talking to yet."
                          : "No sequence is switched on (or this lead is in all of them)."}
                  </p>
                )}
                <ActionForm action={markRepliedAction} submit="They replied" submitClassName="btn">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <p className="hint">A reply stops their sequence emails. Logging a contact does too.</p>
                </ActionForm>
              </div>
            </>
          ) : null}
          <div className="card space-y-3">
            <h2 className="h2">Timeline</h2>
            <ol className="space-y-2 text-sm" data-testid="lead-timeline">
              {events.map((e) => (
                <li key={e.id} className="border-l-2 border-line pl-3 [overflow-wrap:anywhere]">
                  <p>{e.body}</p>
                  <p className="text-xs text-subtle">
                    {e.authorName} · {formatDateTime(e.at, tz)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
          {ctx.can(P.manage) ? (
            <ActionForm action={deleteLeadAction} submit="Delete this lead" submitClassName="btn btn-danger">
              <input type="hidden" name="leadId" value={lead.id} />
              <p className="hint">Deletes the lead and its timeline here. Anything already in Customers stays there.</p>
            </ActionForm>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <>
      <dt className="text-subtle">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
    </>
  );
}

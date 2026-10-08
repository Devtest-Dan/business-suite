import Link from "next/link";
import { z } from "zod";
import { defineAction, defineModule, defineReadTool, type ModuleContext } from "@/lib/modules/contract";
import { toCsv } from "./csv-out";
import { BASE, knownLeadNames, MODULE_ID, needsMeItems, newLeadsForAi, P, searchLeads, setStatus, widgetStats } from "./data";
import { applyImportLead, previewImportLead } from "./import";
import { formatMinutes, STATUS_LABELS } from "./logic";
import { FormPage, FormsPage, NewFormPage } from "./pages/forms";
import { LeadPage, LeadsPage, NewLeadPage } from "./pages/leads";
import { ReportPage } from "./pages/report";
import { NewSequencePage, SequencePage, SequencesPage } from "./pages/sequences";
import { ImportPage, SettingsPage } from "./pages/settings";
import { formPage, submitForm, thanksPage, unsubscribe, unsubscribePage } from "./public";
import { funnelReport, reportCsvRows, stepRates } from "./report";
import { enrollInput, importLeadInput, reportFilter, statusInput, type EnrollInput, type ImportLeadInput, type StatusInput } from "./schemas";
import { applyEnroll, kickDueEmails, listSequences, previewEnroll, previewFirstEmail } from "./sequences";

async function summaryForAi(ctx: ModuleContext, input: { from?: string; to?: string; groupBy: "source" | "utm_source" | "utm_campaign" }) {
  const r = await funnelReport(ctx, reportFilter.parse({ from: input.from ?? "", to: input.to ?? "", group: input.groupBy }));
  const shape = (c: (typeof r)["total"]) => ({
    leads: c.leads,
    contacted: c.contacted,
    qualified: c.qualified,
    converted: c.converted,
    won: r.wonKnown ? c.won : null,
    disqualified: c.disqualified,
    stepRatesPercent: stepRates(c),
    medianSpeedToLeadMinutes: c.medianMinutes === null ? null : Math.round(c.medianMinutes),
    wonValue: r.wonKnown ? (c.wonValueCents / 100).toFixed(2) : null,
  });
  return { from: r.from, to: r.to, groupedBy: r.group, wonKnown: r.wonKnown, total: shape(r.total), groups: r.rows.slice(0, 30).map((g) => ({ group: g.label, ...shape(g) })) };
}

/** Leads: lead forms for the website, a lead inbox with speed to lead, conversion into Customers, email follow-ups and a funnel report. */
export const funnel = defineModule({
  id: MODULE_ID,
  name: "Leads",
  description: "Web forms for your site, a lead inbox with speed to lead, follow-up emails, and a funnel report into Customers.",
  version: "1.0.0",
  icon: "inbox",
  // The shell lists every app's entries together, so few: settings and import are buttons on the pages.
  nav: [
    { label: "Leads", path: "", icon: "inbox" },
    { label: "Funnel report", path: "report", icon: "chart" },
    { label: "Lead forms", path: "forms", icon: "file", permission: P.manage },
    { label: "Email sequences", path: "sequences", icon: "megaphone", permission: P.manage },
  ],
  permissions: [
    { key: P.access, label: "See leads", description: "Open Leads: the lead list, each lead's timeline and the funnel report.", defaultRoles: ["owner", "admin", "member"] },
    { key: P.work, label: "Work leads", description: "Add leads, log contacts, change status, assign, convert into customers and send sequences (for approval).", defaultRoles: ["owner", "admin", "member"] },
    { key: P.manage, label: "Manage forms and sequences", description: "Create lead forms and email sequences, change the Leads settings, delete leads.", defaultRoles: ["owner", "admin"] },
    { key: P.alerts, label: "Get new-lead alerts", description: "Be told (in the app and by phone push) about every new lead that nobody in particular is assigned to.", defaultRoles: ["owner", "admin"] },
    { key: P.import, label: "Import leads", description: "Import leads from CSV (sent for approval, with duplicates left out).", defaultRoles: ["owner", "admin"] },
  ],
  routes: [
    { path: "", title: "Leads", permission: P.access, page: LeadsPage },
    { path: "new", title: "Add a lead", permission: P.work, page: NewLeadPage },
    { path: "leads/:leadId", title: "Lead", permission: P.access, page: LeadPage },
    { path: "report", title: "Funnel report", permission: P.access, page: ReportPage },
    { path: "forms", title: "Lead forms", permission: P.manage, page: FormsPage },
    { path: "forms/new", title: "New lead form", permission: P.manage, page: NewFormPage },
    { path: "forms/:formId", title: "Lead form", permission: P.manage, page: FormPage },
    { path: "sequences", title: "Email sequences", permission: P.manage, page: SequencesPage },
    { path: "sequences/new", title: "New email sequence", permission: P.manage, page: NewSequencePage },
    { path: "sequences/:sequenceId", title: "Email sequence", permission: P.manage, page: SequencePage },
    { path: "settings", title: "Leads settings", permission: P.manage, page: SettingsPage },
    { path: "import", title: "Import leads", permission: P.import, page: ImportPage },
  ],
  api: [
    // auth "self": public on purpose (a visitor's form). public.ts checks the form is on, the size, the rate limits and the honeypot.
    { path: "f/:slug", methods: ["GET", "POST"], auth: "self", handler: (request, props) => (request.method === "POST" ? submitForm(request, props) : formPage(request, props)) },
    { path: "f/:slug/thanks", methods: ["GET"], auth: "self", handler: thanksPage },
    // auth "self": the token is an HMAC of the lead id under the server's secret, checked before anything else (404 otherwise).
    { path: "unsubscribe/:token", methods: ["GET", "POST"], auth: "self", handler: (request, props) => (request.method === "POST" ? unsubscribe(request, props) : unsubscribePage(request, props)) },
    {
      path: "report-csv",
      methods: ["GET"],
      auth: "session",
      permission: P.access,
      handler: async (request, { ctx }) => {
        const report = await funnelReport(ctx, reportFilter.parse(Object.fromEntries(new URL(request.url).searchParams)));
        const [head, ...rows] = reportCsvRows(report);
        return new Response(toCsv(head as string[], rows), {
          headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="funnel-${report.from}-to-${report.to}.csv"`, "cache-control": "no-store" },
        });
      },
    },
  ],
  migrations: { folder: "modules/funnel/migrations" },
  search: { label: "Leads", permission: P.access, search: searchLeads },
  notifications: [
    { kind: "funnel.new_lead", label: "A new lead came in (yours, or nobody's when you get new-lead alerts)", pushByDefault: true },
    { kind: "funnel.assigned", label: "Someone gave you a lead", pushByDefault: true },
  ],
  widget: {
    title: "Leads",
    permission: P.access,
    render: async (ctx) => {
      const s = await widgetStats(ctx);
      return (
        <dl className="grid grid-cols-3 gap-3 text-sm" data-testid="funnel-widget">
          <div>
            <dt className="text-subtle">New today</dt>
            <dd className="text-xl font-semibold tabular-nums">{s.today}</dd>
          </div>
          <div>
            <dt className="text-subtle">Not contacted</dt>
            <dd className="text-xl font-semibold tabular-nums">
              <Link className="link" href={BASE}>
                {s.unworked}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Median speed, 7 days</dt>
            <dd className={`text-xl font-semibold ${s.medianMinutes !== null && s.medianMinutes > s.targetMinutes ? "text-danger" : ""}`}>{s.medianMinutes === null ? "—" : formatMinutes(s.medianMinutes)}</dd>
          </div>
        </dl>
      );
    },
  },
  needsMe: async (ctx) => {
    kickDueEmails();
    return needsMeItems(ctx);
  },
  actions: [
    defineAction<StatusInput>({
      name: "update_lead_status",
      label: "Change a lead's status",
      permission: P.work,
      input: statusInput,
      preview: (s) => `Move the lead ${s.leadName ? s.leadName : s.leadId.slice(0, 8)} to ${STATUS_LABELS[s.status]}${s.status === "disqualified" ? ` (${s.reason})` : ""}`,
      sideEffects: "database",
      apply: async (ctx, input) => {
        const by = ctx.requestedBy ?? ctx.approver;
        const { lead, changed } = await setStatus(ctx.tx, input.leadId, input.status, input.reason, by, ctx.source);
        return { targetId: lead.id, summary: changed ? `Moved ${lead.name} to ${STATUS_LABELS[input.status]}` : `${lead.name} was already ${STATUS_LABELS[input.status].toLowerCase()}` };
      },
    }),
    defineAction<EnrollInput>({
      name: "enroll",
      label: "Send a lead an email sequence",
      permission: P.work,
      input: enrollInput,
      preview: previewEnroll,
      // One enrolment per lead and sequence, ever: the same lead never gets the same sequence twice.
      dedupeKey: (e) => `${e.leadId}:${e.sequenceId}`,
      sideEffects: "database",
      apply: applyEnroll,
      review: async (ctx, input) => {
        const email = await previewFirstEmail(ctx.db, input);
        if (!email) return <p className="muted text-sm">The lead or the sequence no longer exists.</p>;
        return (
          <div className="space-y-1 text-sm">
            <p>
              First email to <span className="font-medium">{email.to}</span>: “{email.subject}”
            </p>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-xs">{email.text}</pre>
          </div>
        );
      },
    }),
    defineAction<ImportLeadInput>({
      name: "import_lead",
      label: "Import a lead",
      permission: P.import,
      input: importLeadInput,
      preview: previewImportLead,
      sideEffects: "database",
      apply: applyImportLead,
    }),
  ],
  knownNames: knownLeadNames,
  aiTools: [
    defineReadTool<{ limit: number }>({
      name: "new_leads",
      description:
        "Leads nobody has contacted yet, oldest first, with how long each has waited and whether that is over the owner's speed-to-lead target. Also lists the email sequences that are switched on (ids for enroll_in_sequence).",
      permission: P.access,
      input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      run: async (ctx, { limit }) => {
        const [leads, sequences] = await Promise.all([newLeadsForAi(ctx, limit), listSequences(ctx.db)]);
        return { ...leads, sequences: sequences.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, emails: s.steps, days: s.lastDay })) };
      },
    }),
    defineReadTool<{ from?: string; to?: string; groupBy: "source" | "utm_source" | "utm_campaign" }>({
      name: "funnel_summary",
      description:
        "The funnel report for a date range (YYYY-MM-DD, default the last 30 days): leads, contacted, qualified, converted, won (from Customers), the conversion between steps in per cent, median speed to lead in minutes and won value, in total and per source (or per utm_source or utm_campaign).",
      permission: P.access,
      input: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        groupBy: z.enum(["source", "utm_source", "utm_campaign"]).default("source"),
      }),
      run: summaryForAi,
    }),
    {
      kind: "write",
      name: "update_lead_status",
      description: "Move a lead to new, contacted, qualified or disqualified (give a reason for disqualified). Give the lead's id and, in leadName, its name. Converting into a customer is done by a person with the Convert button.",
      action: "update_lead_status",
    },
    {
      kind: "write",
      name: "enroll_in_sequence",
      description: "Send one or more leads an email sequence (ids from new_leads), as one approval. Only leads with an email that are new or qualified can get one.",
      action: "enroll",
      batch: true,
    },
  ],
});

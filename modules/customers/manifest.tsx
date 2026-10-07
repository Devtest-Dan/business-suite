import Link from "next/link";
import { z } from "zod";
import { defineAction, defineModule, defineReadTool } from "@/lib/modules/contract";
import {
  addActivity,
  assertSubjectExists,
  BASE,
  customerHistory,
  dealsByStage,
  deliverDueReminders,
  findCustomers,
  formatMoney,
  listFollowUps,
  listStages,
  MODULE_ID,
  P,
  searchCustomers,
  setDealStage,
  todayIn,
  followUpSubjectUrl,
} from "./data";
import { applyFollowUp } from "./follow-ups";
import { applyImportRow, previewImportRow } from "./import";
import { CompaniesPage, CompanyPage, EditCompanyPage, NewCompanyPage } from "./pages/companies";
import { ContactPage, ContactsPage, EditContactPage, NewContactPage } from "./pages/contacts";
import { DealPage, DealsPage, EditDealPage, NewDealPage } from "./pages/deals";
import { FollowUpsPage } from "./pages/follow-ups";
import { ImportPage } from "./pages/import";
import { SettingsPage } from "./pages/settings";
import { seedExamples } from "./seed";
import { dealStageInput, followUpInput, importRowInput, noteInput, type DealStageInput, type FollowUpInput, type ImportRowInput, type NoteInput } from "./schemas";
import { tasksInstalled } from "./tasks-link";

const subjectLabel = (s: { about: string; contactId: string | null; companyId: string | null; dealId: string | null }) =>
  s.about ? `“${s.about}”` : s.contactId ? `contact ${s.contactId.slice(0, 8)}` : s.companyId ? `company ${s.companyId.slice(0, 8)}` : `deal ${s.dealId?.slice(0, 8)}`;

/** Customers: a light CRM for contacts, companies, deals, the timeline and follow-ups. */
export const customers = defineModule({
  id: MODULE_ID,
  name: "Customers",
  description: "Contacts, companies and deals with a pipeline, a timeline of calls and notes, and follow-up reminders.",
  version: "1.0.0",
  icon: "users",
  // The shell lists every app's entries together, so four: Import and the settings are buttons on the pages.
  nav: [
    { label: "Contacts", path: "", icon: "users" },
    { label: "Companies", path: "companies", icon: "grid" },
    { label: "Deals", path: "deals", icon: "chart" },
    { label: "Follow-ups", path: "follow-ups", icon: "calendar" },
  ],
  permissions: [
    { key: P.access, label: "See customers", description: "Open Customers: contacts, companies, deals, timelines and follow-ups.", defaultRoles: ["owner", "admin", "member"] },
    { key: P.edit, label: "Edit customers", description: "Add and change contacts, companies and deals; log calls and notes; set follow-ups.", defaultRoles: ["owner", "admin", "member"] },
    { key: P.delete, label: "Delete customers", description: "Delete contacts, companies and deals (with their timelines).", defaultRoles: ["owner", "admin"] },
    { key: P.pipeline, label: "Change the pipeline and fields", description: "Rename, add and reorder pipeline stages; add custom fields.", defaultRoles: ["owner", "admin"] },
    { key: P.import, label: "Import customers", description: "Import contacts from CSV (sent for approval, with duplicates proposed as merges).", defaultRoles: ["owner", "admin"] },
    { key: P.export, label: "Export customers", description: "Download contacts, companies and deals as CSV.", defaultRoles: ["owner", "admin"] },
  ],
  routes: [
    { path: "", title: "Contacts", permission: P.access, page: ContactsPage },
    { path: "new", title: "New contact", permission: P.edit, page: NewContactPage },
    { path: "contacts/:contactId", title: "Contact", permission: P.access, page: ContactPage },
    { path: "contacts/:contactId/edit", title: "Edit contact", permission: P.edit, page: EditContactPage },
    { path: "companies", title: "Companies", permission: P.access, page: CompaniesPage },
    { path: "companies/new", title: "New company", permission: P.edit, page: NewCompanyPage },
    { path: "companies/:companyId", title: "Company", permission: P.access, page: CompanyPage },
    { path: "companies/:companyId/edit", title: "Edit company", permission: P.edit, page: EditCompanyPage },
    { path: "deals", title: "Deals", permission: P.access, page: DealsPage },
    { path: "deals/new", title: "New deal", permission: P.edit, page: NewDealPage },
    { path: "deals/:dealId", title: "Deal", permission: P.access, page: DealPage },
    { path: "deals/:dealId/edit", title: "Edit deal", permission: P.edit, page: EditDealPage },
    { path: "follow-ups", title: "Follow-ups", permission: P.access, page: FollowUpsPage },
    { path: "import", title: "Import contacts", permission: P.import, page: ImportPage },
    { path: "settings", title: "Pipeline and fields", permission: P.pipeline, page: SettingsPage },
  ],
  migrations: { folder: "modules/customers/migrations" },
  search: { label: "Customers", permission: P.access, search: searchCustomers },
  notifications: [
    { kind: "customers.follow_up_due", label: "A customer follow-up of yours is due", pushByDefault: true },
    { kind: "customers.assigned", label: "You are made the owner of a contact, company or deal", pushByDefault: false },
  ],
  widget: {
    title: "Customers",
    permission: P.access,
    render: async (ctx) => {
      const today = todayIn(ctx.business.timezone);
      const [mine, stages] = await Promise.all([listFollowUps(ctx.db, { assigneeId: ctx.viewer.id, status: "open", dueBy: today }, 50), dealsByStage(ctx.db)]);
      const overdue = mine.filter((f) => f.dueOn < today).length;
      const open = stages.filter((s) => s.kind === "open");
      const most = Math.max(1, ...open.map((s) => s.deals));
      return (
        <div className="space-y-4 text-sm">
          <div data-testid="customers-widget-follow-ups">
            <p className="font-medium">Follow-ups due</p>
            {mine.length === 0 ? (
              <p className="muted">None due today.</p>
            ) : (
              <p>
                <Link className="link" href={`${BASE}/follow-ups`}>
                  {mine.length} due{overdue ? `, ${overdue} overdue` : ""}
                </Link>
              </p>
            )}
          </div>
          <div>
            <p className="font-medium">Open deals by stage</p>
            <ul className="mt-1 space-y-1" data-testid="customers-widget-stages">
              {open.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate">{s.name}</span>
                  <span className="h-2 rounded-full bg-accent" style={{ width: `${Math.max(4, (s.deals / most) * 100)}%`, maxWidth: "60%" }} aria-hidden />
                  <span className="text-subtle">{s.deals}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    },
  },
  needsMe: async (ctx) => {
    if (!ctx.can(P.access)) return [];
    await deliverDueReminders(ctx.db, ctx.viewer.id, ctx.business.timezone);
    const today = todayIn(ctx.business.timezone);
    const due = await listFollowUps(ctx.db, { assigneeId: ctx.viewer.id, status: "open", dueBy: today }, 5);
    return due
      .filter((f) => f.via === "here")
      .map((f) => ({
        title: `${f.dueOn < today ? "Overdue" : "Today"}: ${f.title}`,
        detail: f.contactName ?? f.companyName ?? f.dealTitle ?? "Customer follow-up",
        url: followUpSubjectUrl(f),
      }));
  },
  actions: [
    defineAction<ImportRowInput>({
      name: "import_contact",
      label: "Import a contact",
      permission: P.import,
      input: importRowInput,
      preview: previewImportRow,
      sideEffects: "database",
      apply: applyImportRow,
    }),
    defineAction<NoteInput>({
      name: "add_note",
      label: "Add to a customer's timeline",
      permission: P.edit,
      input: noteInput,
      preview: (n) => `Add a ${n.kind} to ${subjectLabel(n)}: ${n.body.slice(0, 160)}${n.body.length > 160 ? "…" : ""}`,
      sideEffects: "database",
      apply: async (ctx, input) => {
        const by = ctx.requestedBy ?? ctx.approver;
        const about = await assertSubjectExists(ctx.tx, input);
        const row = await addActivity(ctx.tx, input, by, { via: ctx.source, sourceKey: `${ctx.approvalId}:${ctx.dedupeKey}` });
        return { targetId: row.id, summary: `Added a ${row.kind} to ${about}` };
      },
    }),
    defineAction<FollowUpInput>({
      name: "create_follow_up",
      label: "Create a customer follow-up",
      permission: P.edit,
      input: followUpInput,
      preview: (f) =>
        `Follow up with ${subjectLabel(f)} by ${f.dueOn}: ${f.title}${f.assigneeEmail ? ` (for ${f.assigneeEmail})` : ""}${tasksInstalled() ? " — as a task in Tasks when that app is on" : ""}`,
      sideEffects: "database",
      apply: applyFollowUp,
    }),
    defineAction<DealStageInput>({
      name: "update_deal_stage",
      label: "Move a deal to another stage",
      permission: P.edit,
      input: dealStageInput,
      preview: (d) => `Move the deal ${d.dealTitle ? `“${d.dealTitle}”` : d.dealId.slice(0, 8)} to the stage “${d.stage}”`,
      sideEffects: "database",
      apply: async (ctx, input) => {
        const stages = await listStages(ctx.tx);
        const stage = stages.find((s) => s.name.toLowerCase() === input.stage.toLowerCase());
        if (!stage) throw new Error(`There is no stage called “${input.stage}”. The stages are: ${stages.map((s) => s.name).join(", ")}.`);
        const by = ctx.requestedBy ?? ctx.approver;
        const { deal, changed } = await setDealStage(ctx.tx, input.dealId, stage.id, by, ctx.source, `${ctx.approvalId}:${ctx.dedupeKey}`);
        return { targetId: deal.id, summary: changed ? `Moved “${deal.title}” to ${stage.name}` : `“${deal.title}” was already in ${stage.name}` };
      },
    }),
  ],
  aiTools: [
    defineReadTool<{ query: string }>({
      name: "find_customers",
      description: "Find contacts and companies by name, email, phone, job title or a word in their notes. Returns ids to use with the other customer tools.",
      permission: P.access,
      input: z.object({ query: z.string().trim().min(1).max(200) }),
      run: async (ctx, { query }) => findCustomers(ctx, query, 10),
    }),
    defineReadTool<{ contactId?: string; companyId?: string }>({
      name: "customer_history",
      description:
        "A customer's record, deals, open follow-ups and timeline (calls, emails, meetings, notes, stage changes), newest first. Give contactId or companyId (from find_customers). Use it to summarise a customer's history.",
      permission: P.access,
      input: z
        .object({ contactId: z.string().uuid().optional(), companyId: z.string().uuid().optional() })
        .refine((v) => Boolean(v.contactId || v.companyId), "Give contactId or companyId."),
      run: async (ctx, input) => customerHistory(ctx, input),
    }),
    defineReadTool<{ days: number; everyone: boolean }>({
      name: "customer_follow_ups_due",
      description: "Open customer follow-ups due within the next few days (overdue ones included). By default only the asking person's; everyone: true for the whole team.",
      permission: P.access,
      input: z.object({ days: z.number().int().min(0).max(60).default(7), everyone: z.boolean().default(false) }),
      run: async (ctx, { days, everyone }) => {
        const until = todayIn(ctx.business.timezone, new Date(Date.now() + days * 86_400_000));
        const rows = await listFollowUps(ctx.db, { status: "open", dueBy: until, assigneeId: everyone ? undefined : ctx.viewer.id }, 100);
        return rows.map((f) => ({ id: f.id, title: f.title, dueOn: f.dueOn, assignee: f.assigneeName, about: f.contactName ?? f.companyName ?? f.dealTitle, where: f.via === "tasks" ? "Tasks app" : "Customers" }));
      },
    }),
    defineReadTool<Record<string, never>>({
      name: "deals_by_stage",
      description: "The sales pipeline: each stage with how many deals it holds and their total value (won and lost count the last 30 days).",
      permission: P.access,
      input: z.object({}),
      run: async (ctx) => (await dealsByStage(ctx.db)).map((s) => ({ stage: s.name, kind: s.kind, deals: s.deals, totalValue: formatMoney(s.valueCents) })),
    }),
    { kind: "write", name: "add_customer_note", description: "Add a note (or a logged call, email or meeting) to a contact's, company's or deal's timeline. Give the id and, in `about`, the name.", action: "add_note" },
    { kind: "write", name: "add_customer_notes", description: "Add several timeline notes at once, as one approval.", action: "add_note", batch: true },
    {
      kind: "write",
      name: "create_customer_follow_up",
      description: "Create a follow-up reminder about a contact, company or deal, due on a date (YYYY-MM-DD). It becomes a task in the Tasks app when that app is on.",
      action: "create_follow_up",
    },
    { kind: "write", name: "update_deal_stage", description: "Move a deal to another pipeline stage, by the stage's name. Give dealTitle too, for the approver.", action: "update_deal_stage" },
  ],
  seed: seedExamples,
});

import "server-only";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { audit, SYSTEM_ACTOR, userActor } from "@/lib/audit";
import type { Db, DbTx } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { ModuleContext, NeedsMeItem, SearchHit } from "@/lib/modules/contract";
import { notify, usersWithPermission } from "@/lib/notifications";
import {
  CONTACT_KIND_LABELS,
  DEFAULT_TARGET_MINUTES,
  emailKey,
  formatMinutes,
  median,
  minutesBetween,
  phoneKey,
  SOURCE_LABELS,
  STATUS_LABELS,
  type LeadSource,
  type LeadStatus,
} from "./logic";
import { funnelEnrollments, funnelForms, funnelLeadEvents, funnelLeads, funnelSends, funnelSettings } from "./schema";
import type { FormConfigInput, LeadListFilter } from "./schemas";

export const MODULE_ID = "funnel";
export const BASE = `/m/${MODULE_ID}`;
export const P = {
  access: "funnel.access",
  work: "funnel.work",
  manage: "funnel.manage",
  alerts: "funnel.alerts",
  import: "funnel.import",
} as const;

type Q = Db | DbTx;
export type Person = { id: string; name: string };

export type Lead = Omit<typeof funnelLeads.$inferSelect, "search">;
export type Form = typeof funnelForms.$inferSelect;
export type LeadEvent = typeof funnelLeadEvents.$inferSelect;
export type LeadRow = Lead & { assigneeName: string | null };

const { search: _search, ...leadCols } = getTableColumns(funnelLeads);
void _search;

export const leadUrl = (id: string) => `${BASE}/leads/${id}`;

/** Today's date (YYYY-MM-DD) in the business's timezone. */
export function todayIn(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface FunnelSettings {
  targetMinutes: number;
  postalAddress: string;
}

export async function getSettings(q: Q): Promise<FunnelSettings> {
  const [row] = await q.select().from(funnelSettings).where(eq(funnelSettings.id, 1));
  return { targetMinutes: row?.targetMinutes ?? DEFAULT_TARGET_MINUTES, postalAddress: row?.postalAddress ?? "" };
}

export async function saveSettings(ctx: ModuleContext, input: FunnelSettings): Promise<void> {
  const before = await getSettings(ctx.db);
  await ctx.db
    .insert(funnelSettings)
    .values({ id: 1, ...input, updatedBy: ctx.viewer.id })
    .onConflictDoUpdate({ target: funnelSettings.id, set: { ...input, updatedBy: ctx.viewer.id, updatedAt: new Date() } });
  // Without a postal address no email may go out: switch the sequences off.
  if (before.postalAddress && !input.postalAddress) {
    const { deactivateAllSequences } = await import("./sequences");
    await deactivateAllSequences(ctx.db, "the postal address was removed from the settings");
  }
  await audit({
    actor: userActor(ctx.viewer),
    action: "funnel.settings_changed",
    module: MODULE_ID,
    summary: `${ctx.viewer.name} changed the Leads settings (speed-to-lead target ${input.targetMinutes} min${input.postalAddress ? ", postal address set" : ", no postal address"}).`,
  });
}

// ── People ──────────────────────────────────────────────────────────────────

export async function listPeople(q: Q): Promise<{ id: string; name: string; email: string }[]> {
  return q
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.status, "active"), ne(users.role, "guest")))
    .orderBy(asc(users.name));
}

async function assertAssignable(q: Q, id: string | null): Promise<void> {
  if (!id) return;
  const [u] = await q.select({ id: users.id }).from(users).where(and(eq(users.id, id), eq(users.status, "active"), ne(users.role, "guest")));
  if (!u) throw new UserError("That person is not an active member of the team. Pick someone else.");
}

// ── Forms ───────────────────────────────────────────────────────────────────

export function newSlug(): string {
  return randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");
}

export async function listForms(q: Q) {
  const counts = q
    .select({ formId: funnelLeads.formId, n: sql<number>`count(*)::int`.as("n") })
    .from(funnelLeads)
    .groupBy(funnelLeads.formId)
    .as("counts");
  return q
    .select({ ...getTableColumns(funnelForms), leads: sql<number>`coalesce(${counts.n}, 0)` })
    .from(funnelForms)
    .leftJoin(counts, eq(counts.formId, funnelForms.id))
    .orderBy(asc(funnelForms.name));
}

export async function getForm(q: Q, id: string): Promise<Form | null> {
  const [row] = await q.select().from(funnelForms).where(eq(funnelForms.id, id));
  return row ?? null;
}

export async function getFormBySlug(q: Q, slug: string): Promise<Form | null> {
  if (!/^[a-z0-9]{6,40}$/.test(slug)) return null;
  const [row] = await q.select().from(funnelForms).where(eq(funnelForms.slug, slug));
  return row ?? null;
}

export async function saveForm(ctx: ModuleContext, input: FormConfigInput): Promise<Form> {
  await assertAssignable(ctx.db, input.assigneeId);
  const { id, ...values } = input;
  let row: Form | undefined;
  if (id) {
    [row] = await ctx.db.update(funnelForms).set({ ...values, updatedAt: new Date() }).where(eq(funnelForms.id, id)).returning();
    if (!row) throw new UserError("This form no longer exists. Reload the page.");
  } else {
    [row] = await ctx.db.insert(funnelForms).values({ ...values, slug: newSlug(), createdBy: ctx.viewer.id }).returning();
  }
  await audit({
    actor: userActor(ctx.viewer),
    action: id ? "funnel.form_changed" : "funnel.form_added",
    module: MODULE_ID,
    target: { type: "form", id: row.id },
    summary: `${ctx.viewer.name} ${id ? "changed" : "added"} the lead form "${row.name}"${row.active ? "" : " (switched off)"}.`,
  });
  return row;
}

// ── Leads ───────────────────────────────────────────────────────────────────

export interface NewLead {
  name: string;
  email: string;
  phone: string;
  company: string;
  message: string;
  service: string;
  contactMethod: string;
  source: LeadSource;
  sourceDetail: string;
  formId?: string | null;
  pageUrl?: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  consentText?: string;
  assigneeId: string | null;
}

/**
 * Adds a lead and its first timeline entry. `by` is null for a visitor's form
 * submission. `alreadyContacted`: the person adding it has spoken to them (a
 * phone call or a walk-in), so the first contact is now.
 */
export async function createLead(q: Q, input: NewLead, by: Person | null, options: { alreadyContacted?: boolean; sourceKey?: string } = {}): Promise<Lead> {
  await assertAssignable(q, input.assigneeId);
  const now = new Date();
  const [row] = (await q
    .insert(funnelLeads)
    .values({
      ...input,
      formId: input.formId ?? null,
      consentAt: input.consentText ? now : null,
      status: options.alreadyContacted ? "contacted" : "new",
      firstContactAt: options.alreadyContacted ? now : null,
      createdBy: by?.id ?? null,
      emailKey: emailKey(input.email),
      phoneKey: phoneKey(input.phone),
      sourceKey: options.sourceKey ?? null,
    })
    .returning(leadCols)) as Lead[];
  const where = SOURCE_LABELS[input.source] + (input.sourceDetail ? ` (${input.sourceDetail})` : "");
  await addEvent(q, row.id, "received", `Lead received: ${where}.${options.alreadyContacted ? " Already spoken to when it was added." : ""}`, by);
  await audit(
    {
      actor: by ? userActor(by) : { ...SYSTEM_ACTOR, name: "Website form" },
      action: "funnel.lead_added",
      module: MODULE_ID,
      target: { type: "lead", id: row.id },
      summary: by ? `${by.name} added the lead "${row.name}" (${where}).` : `A visitor sent the form "${input.sourceDetail}": new lead "${row.name}".`,
    },
    q,
  );
  return row;
}

/** Tells the assigned person, or everyone who gets new-lead alerts, about a new lead (in-app and phone push). */
export async function announceLead(lead: Lead, targetMinutes: number, except: string | null = null): Promise<void> {
  const to = (lead.assigneeId ? [lead.assigneeId] : await usersWithPermission(P.alerts)).filter((id) => id !== except);
  if (!to.length) return;
  const what = [lead.service ? `wants ${lead.service}` : "", SOURCE_LABELS[lead.source as LeadSource] + (lead.sourceDetail ? ` “${lead.sourceDetail}”` : "")].filter(Boolean).join(" · ");
  await notify(to, {
    kind: "funnel.new_lead",
    title: `New lead: ${lead.name}`,
    body: lead.status === "new" ? `${what}. Your target is to contact them within ${targetMinutes} min.` : what,
    url: leadUrl(lead.id),
  });
}

/** `by`: the person, or for automatic entries the name to show (a visitor's form is "Website form"). */
export async function addEvent(q: Q, leadId: string, kind: string, body: string, by: Person | string | null): Promise<void> {
  const person = typeof by === "object" ? by : null;
  const name = typeof by === "string" ? by : (by?.name ?? "Website form");
  await q.insert(funnelLeadEvents).values({ leadId, kind, body: body.slice(0, 4000), authorId: person?.id ?? null, authorName: name });
}

const leadSelect = { ...leadCols, assigneeName: users.name };

export async function getLead(q: Q, id: string): Promise<LeadRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await q.select(leadSelect).from(funnelLeads).leftJoin(users, eq(users.id, funnelLeads.assigneeId)).where(eq(funnelLeads.id, id));
  return (row as LeadRow) ?? null;
}

export async function listLeads(ctx: ModuleContext, f: Partial<LeadListFilter> = {}, limit = 200): Promise<LeadRow[]> {
  const where: (SQL | undefined)[] = [];
  if (f.status === "open") where.push(inArray(funnelLeads.status, ["new", "contacted", "qualified"]));
  else if (f.status) where.push(eq(funnelLeads.status, f.status as LeadStatus));
  if (f.who === "me") where.push(eq(funnelLeads.assigneeId, ctx.viewer.id));
  if (f.who === "unassigned") where.push(isNull(funnelLeads.assigneeId));
  if (f.source && (Object.keys(SOURCE_LABELS) as string[]).includes(f.source)) where.push(eq(funnelLeads.source, f.source as LeadSource));
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(sql`${funnelLeads.search} @@ websearch_to_tsquery('simple', ${f.q})`, ilike(funnelLeads.name, like), ilike(funnelLeads.email, like), ilike(funnelLeads.phone, like)));
  }
  return (await ctx.db
    .select(leadSelect)
    .from(funnelLeads)
    .leftJoin(users, eq(users.id, funnelLeads.assigneeId))
    .where(and(...where))
    // Unworked first, oldest first among them: that is the order to call people back in.
    .orderBy(sql`(${funnelLeads.status} = 'new') desc`, sql`case when ${funnelLeads.status} = 'new' then ${funnelLeads.createdAt} end asc`, desc(funnelLeads.createdAt))
    .limit(limit)) as LeadRow[];
}

export async function leadEvents(q: Q, leadId: string): Promise<LeadEvent[]> {
  return q.select().from(funnelLeadEvents).where(eq(funnelLeadEvents.leadId, leadId)).orderBy(desc(funnelLeadEvents.at), desc(funnelLeadEvents.id));
}

async function mustGet(q: Q, leadId: string): Promise<LeadRow> {
  const lead = await getLead(q, leadId);
  if (!lead) throw new UserError("This lead no longer exists. It may have been deleted.");
  return lead;
}

/** Speed to lead, in minutes, once the first contact is logged. */
export function speedMinutes(lead: Pick<Lead, "createdAt" | "firstContactAt">): number | null {
  return minutesBetween(lead.createdAt, lead.firstContactAt);
}

/** Minutes a new lead has waited so far, or its speed to lead once contacted; and whether that is over the target. */
export function waiting(lead: Pick<Lead, "createdAt" | "firstContactAt" | "status" | "source">, targetMinutes: number, now = new Date()): { minutes: number | null; over: boolean; contacted: boolean } {
  if (lead.source === "import") return { minutes: null, over: false, contacted: Boolean(lead.firstContactAt) };
  if (lead.firstContactAt) {
    const m = speedMinutes(lead)!;
    return { minutes: m, over: m > targetMinutes, contacted: true };
  }
  if (lead.status !== "new") return { minutes: null, over: false, contacted: false };
  const m = minutesBetween(lead.createdAt, now)!;
  return { minutes: m, over: m > targetMinutes, contacted: false };
}

/** Stops every active sequence of a lead and cancels its emails not yet sent. Returns how many stopped. */
export async function stopSequences(q: Q, leadId: string, reason: string): Promise<number> {
  const stopped = await q
    .update(funnelEnrollments)
    .set({ status: "stopped", stopReason: reason.slice(0, 200), stoppedAt: new Date() })
    .where(and(eq(funnelEnrollments.leadId, leadId), eq(funnelEnrollments.status, "active")))
    .returning({ id: funnelEnrollments.id });
  if (!stopped.length) return 0;
  await q
    .update(funnelSends)
    .set({ status: "cancelled" })
    .where(and(inArray(funnelSends.enrollmentId, stopped.map((s) => s.id)), eq(funnelSends.status, "scheduled")));
  return stopped.length;
}

/** A first (or later) contact: speed to lead is measured to the first one; a new lead becomes contacted; sequences stop. */
export async function logContact(q: Q, leadId: string, kind: keyof typeof CONTACT_KIND_LABELS, note: string, by: Person): Promise<{ first: boolean; minutes: number | null }> {
  const lead = await mustGet(q, leadId);
  const now = new Date();
  const first = !lead.firstContactAt;
  await q
    .update(funnelLeads)
    .set({ firstContactAt: lead.firstContactAt ?? now, status: lead.status === "new" ? "contacted" : lead.status, updatedAt: now })
    .where(eq(funnelLeads.id, leadId));
  await addEvent(q, leadId, "contact", `${CONTACT_KIND_LABELS[kind]}${note ? `: ${note}` : "."}`, by);
  const stopped = await stopSequences(q, leadId, `${by.name} logged a contact`);
  if (stopped) await addEvent(q, leadId, "sequence", "Sequence emails stopped: someone is now talking to this lead.", by);
  const minutes = first ? minutesBetween(lead.createdAt, now) : null;
  if (first) {
    await audit({ actor: userActor(by), action: "funnel.first_contact", module: MODULE_ID, target: { type: "lead", id: leadId }, summary: `${by.name} first contacted the lead "${lead.name}" (${formatMinutes(minutes)} after it came in).` }, q);
  }
  return { first, minutes };
}

/** Moves a lead to a status. Converted is final (set only by the conversion); contacted, converted and disqualified stop sequences. */
export async function setStatus(q: Q, leadId: string, status: "new" | "contacted" | "qualified" | "disqualified", reason: string, by: Person, via = "user"): Promise<{ lead: LeadRow; changed: boolean }> {
  const lead = await mustGet(q, leadId);
  if (lead.status === "converted") throw new UserError(`“${lead.name}” was already converted into a customer, so its status cannot change here. Carry on in Customers.`);
  if (status === "disqualified" && !reason.trim()) throw new UserError("Say why the lead is disqualified.");
  if (lead.status === status && (status !== "disqualified" || lead.disqualifyReason === reason)) return { lead, changed: false };
  const now = new Date();
  const set: Partial<typeof funnelLeads.$inferInsert> = { status, updatedAt: now };
  if (status === "contacted" || status === "qualified") set.firstContactAt = lead.firstContactAt ?? now;
  if (status === "qualified") set.qualifiedAt = lead.qualifiedAt ?? now;
  if (status === "disqualified") {
    set.disqualifiedAt = now;
    set.disqualifyReason = reason.trim().slice(0, 300);
  }
  if (status === "new") set.disqualifyReason = "";
  await q.update(funnelLeads).set(set).where(eq(funnelLeads.id, leadId));
  const text = `Status: ${STATUS_LABELS[lead.status as LeadStatus]} → ${STATUS_LABELS[status]}${status === "disqualified" ? ` (${reason.trim()})` : ""}${via === "ai" ? " — proposed by the assistant, approved" : ""}.`;
  await addEvent(q, leadId, "status", text, by);
  if (status === "contacted" || status === "disqualified") {
    const stopped = await stopSequences(q, leadId, `status changed to ${STATUS_LABELS[status].toLowerCase()}`);
    if (stopped) await addEvent(q, leadId, "sequence", `Sequence emails stopped: the lead is now ${STATUS_LABELS[status].toLowerCase()}.`, by);
  }
  await audit({ actor: userActor(by), action: "funnel.status", module: MODULE_ID, target: { type: "lead", id: leadId }, summary: `${by.name} moved the lead "${lead.name}": ${text}` }, q);
  return { lead: { ...lead, ...set } as LeadRow, changed: true };
}

export async function assignLead(ctx: ModuleContext, leadId: string, assigneeId: string | null): Promise<LeadRow> {
  const lead = await mustGet(ctx.db, leadId);
  await assertAssignable(ctx.db, assigneeId);
  if (lead.assigneeId === assigneeId) return lead;
  await ctx.db.update(funnelLeads).set({ assigneeId, updatedAt: new Date() }).where(eq(funnelLeads.id, leadId));
  const [person] = assigneeId ? await ctx.db.select({ name: users.name }).from(users).where(eq(users.id, assigneeId)) : [];
  await addEvent(ctx.db, leadId, "assigned", person ? `Assigned to ${person.name}.` : "No longer assigned to anyone.", ctx.viewer);
  if (assigneeId && assigneeId !== ctx.viewer.id) {
    await notify([assigneeId], { kind: "funnel.assigned", title: `${ctx.viewer.name} gave you the lead ${lead.name}`, body: lead.status === "new" ? "Not contacted yet." : undefined, url: leadUrl(lead.id) });
  }
  return { ...lead, assigneeId };
}

export async function markReplied(ctx: ModuleContext, leadId: string): Promise<number> {
  const lead = await mustGet(ctx.db, leadId);
  await ctx.db.update(funnelLeads).set({ repliedAt: lead.repliedAt ?? new Date(), updatedAt: new Date() }).where(eq(funnelLeads.id, leadId));
  await addEvent(ctx.db, leadId, "replied", "They replied.", ctx.viewer);
  const stopped = await stopSequences(ctx.db, leadId, "the lead replied");
  if (stopped) await addEvent(ctx.db, leadId, "sequence", "Sequence emails stopped: the lead replied.", ctx.viewer);
  return stopped;
}

export async function deleteLead(ctx: ModuleContext, leadId: string): Promise<void> {
  const [row] = await ctx.db.delete(funnelLeads).where(eq(funnelLeads.id, leadId)).returning({ name: funnelLeads.name });
  if (!row) throw new UserError("This lead was already deleted.");
  await audit({ actor: userActor(ctx.viewer), action: "funnel.lead_deleted", module: MODULE_ID, target: { type: "lead", id: leadId }, summary: `${ctx.viewer.name} deleted the lead "${row.name}" and its timeline.` });
}

// ── Home page, search and the assistant ─────────────────────────────────────

/** New leads waiting for the viewer: assigned to them, or unassigned when they get new-lead alerts. Oldest first. */
export async function unworkedFor(ctx: ModuleContext, limit = 5): Promise<LeadRow[]> {
  const mine = ctx.can(P.alerts) ? or(eq(funnelLeads.assigneeId, ctx.viewer.id), isNull(funnelLeads.assigneeId)) : eq(funnelLeads.assigneeId, ctx.viewer.id);
  return (await ctx.db
    .select(leadSelect)
    .from(funnelLeads)
    .leftJoin(users, eq(users.id, funnelLeads.assigneeId))
    .where(and(eq(funnelLeads.status, "new"), mine))
    .orderBy(asc(funnelLeads.createdAt))
    .limit(limit)) as LeadRow[];
}

export async function needsMeItems(ctx: ModuleContext): Promise<NeedsMeItem[]> {
  if (!ctx.can(P.work)) return [];
  const [leads, settings] = await Promise.all([unworkedFor(ctx, 5), getSettings(ctx.db)]);
  return leads.map((l) => {
    const w = waiting(l, settings.targetMinutes);
    return {
      title: `New lead: ${l.name}`,
      detail: [SOURCE_LABELS[l.source as LeadSource], w.minutes !== null ? `waiting ${formatMinutes(w.minutes)}${w.over ? `, over your ${settings.targetMinutes}-minute target` : ""}` : ""].filter(Boolean).join(" · "),
      url: leadUrl(l.id),
    };
  });
}

/** The dashboard numbers: new leads today, unworked leads, and the median speed to lead over the last 7 days. */
export async function widgetStats(ctx: ModuleContext) {
  const tz = ctx.business.timezone;
  const [counts] = await ctx.db
    .select({
      today: sql<number>`count(*) filter (where (${funnelLeads.createdAt} at time zone ${tz})::date = (now() at time zone ${tz})::date)::int`,
      unworked: sql<number>`count(*) filter (where ${funnelLeads.status} = 'new')::int`,
    })
    .from(funnelLeads);
  const week = await ctx.db
    .select({ createdAt: funnelLeads.createdAt, firstContactAt: funnelLeads.firstContactAt })
    .from(funnelLeads)
    .where(and(sql`${funnelLeads.createdAt} > now() - interval '7 days'`, ne(funnelLeads.source, "import"), sql`${funnelLeads.firstContactAt} is not null`));
  const settings = await getSettings(ctx.db);
  return { today: counts?.today ?? 0, unworked: counts?.unworked ?? 0, medianMinutes: median(week.map((l) => speedMinutes(l)!)), contactedThisWeek: week.length, targetMinutes: settings.targetMinutes };
}

export async function searchLeads(ctx: ModuleContext, query: string, limit: number): Promise<SearchHit[]> {
  const q = sql`websearch_to_tsquery('simple', ${query})`;
  const rows = await ctx.db
    .select({
      id: funnelLeads.id,
      title: funnelLeads.name,
      at: funnelLeads.createdAt,
      status: funnelLeads.status,
      rank: sql<number>`ts_rank(${funnelLeads.search}, ${q})`,
      snippet: sql<string>`concat_ws(' · ', nullif(${funnelLeads.service}, ''), nullif(${funnelLeads.email}, ''), nullif(${funnelLeads.phone}, ''))`,
    })
    .from(funnelLeads)
    .where(sql`${funnelLeads.search} @@ ${q}`)
    .orderBy(sql`5 desc`)
    .limit(limit);
  return rows.map((r) => ({ title: r.title, snippet: `Lead · ${STATUS_LABELS[r.status as LeadStatus]}${r.snippet ? ` · ${r.snippet}` : ""}`, url: leadUrl(r.id), rank: Number(r.rank), at: r.at }));
}

/** Lead names the viewer may see, newest first, for the assistant's name references. */
export async function knownLeadNames(ctx: ModuleContext): Promise<string[]> {
  if (!ctx.can(P.access)) return [];
  const rows = await ctx.db.select({ name: funnelLeads.name }).from(funnelLeads).orderBy(desc(funnelLeads.createdAt)).limit(5000);
  return rows.map((r) => r.name);
}

/** Unworked leads, oldest first, as small JSON for the assistant. */
export async function newLeadsForAi(ctx: ModuleContext, limit: number) {
  const [rows, settings] = await Promise.all([
    ctx.db
      .select(leadSelect)
      .from(funnelLeads)
      .leftJoin(users, eq(users.id, funnelLeads.assigneeId))
      .where(eq(funnelLeads.status, "new"))
      .orderBy(asc(funnelLeads.createdAt))
      .limit(limit) as Promise<LeadRow[]>,
    getSettings(ctx.db),
  ]);
  return {
    targetMinutes: settings.targetMinutes,
    leads: rows.map((l) => {
      const w = waiting(l, settings.targetMinutes);
      return {
        id: l.id,
        name: l.name,
        service: l.service || null,
        source: SOURCE_LABELS[l.source as LeadSource],
        form: l.source === "form" ? l.sourceDetail : null,
        receivedAt: l.createdAt.toISOString(),
        waitingMinutes: w.minutes === null ? null : Math.round(w.minutes),
        overTarget: w.over,
        assignee: l.assigneeName,
        prefers: l.contactMethod || null,
      };
    }),
  };
}

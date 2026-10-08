import "server-only";
import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import type { Db, DbTx } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { ModuleContext, SearchHit } from "@/lib/modules/contract";
import { notify } from "@/lib/notifications";
import { emailKey, nameKey, phoneKey } from "./dedupe";
import {
  customerActivities,
  customerCompanies,
  customerContacts,
  customerDeals,
  customerFields,
  customerFollowUps,
  customerSavedFilters,
  customerStages,
} from "./schema";
import type { ActivityKind, CompanyInput, FieldDef, ListFilter } from "./schemas";

export const MODULE_ID = "customers";
export const BASE = `/m/${MODULE_ID}`;
export const P = {
  access: "customers.access",
  edit: "customers.edit",
  delete: "customers.delete",
  pipeline: "customers.pipeline",
  import: "customers.import",
  export: "customers.export",
} as const;

type Q = Db | DbTx;
type Person = { id: string; name: string };

export type Contact = Omit<typeof customerContacts.$inferSelect, "search">;
export type Company = Omit<typeof customerCompanies.$inferSelect, "search">;
export type Deal = Omit<typeof customerDeals.$inferSelect, "search">;
export type Stage = typeof customerStages.$inferSelect;
export type Activity = Omit<typeof customerActivities.$inferSelect, "search">;
export type FollowUp = typeof customerFollowUps.$inferSelect;

/** A table's columns without its generated search vector (never sent anywhere). */
function columnsOf<T extends Parameters<typeof getTableColumns>[0]>(table: T) {
  const { search: _search, ...rest } = getTableColumns(table) as ReturnType<typeof getTableColumns<T>> & { search: unknown };
  void _search;
  return rest;
}
const contactCols = columnsOf(customerContacts);
const companyCols = columnsOf(customerCompanies);
const dealCols = columnsOf(customerDeals);
const activityCols = columnsOf(customerActivities);

/** Today's date (YYYY-MM-DD) in the business's timezone. */
export function todayIn(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── People (owners and assignees) ───────────────────────────────────────────

export async function listPeople(q: Q): Promise<{ id: string; name: string; email: string }[]> {
  return q.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.status, "active")).orderBy(asc(users.name));
}

export async function userIdByEmail(q: Q, email: string): Promise<string | null> {
  if (!email) return null;
  const [u] = await q.select({ id: users.id }).from(users).where(and(eq(users.email, email.toLowerCase()), eq(users.status, "active")));
  return u?.id ?? null;
}

async function assertActiveUser(q: Q, id: string | null): Promise<void> {
  if (!id) return;
  const [u] = await q.select({ id: users.id }).from(users).where(and(eq(users.id, id), eq(users.status, "active")));
  if (!u) throw new UserError("That person is not an active member of the team. Pick someone else.");
}

async function tellNewOwner(by: Person, ownerId: string | null, previous: string | null, what: string, url: string): Promise<void> {
  if (!ownerId || ownerId === by.id || ownerId === previous) return;
  await notify([ownerId], { kind: "customers.assigned", title: `${by.name} made you the owner of ${what}`, url });
}

// ── Custom fields ───────────────────────────────────────────────────────────

export async function listFields(q: Q, entity: "contact" | "company" | "deal"): Promise<(FieldDef & { id: string })[]> {
  return q
    .select({ id: customerFields.id, key: customerFields.key, label: customerFields.label, type: customerFields.type, options: customerFields.options })
    .from(customerFields)
    .where(eq(customerFields.entity, entity))
    .orderBy(asc(customerFields.position), asc(customerFields.createdAt));
}

// ── Filters for lists ───────────────────────────────────────────────────────

function textMatch(search: SQL | unknown, cols: unknown[], query: string): SQL {
  const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return or(sql`${search} @@ websearch_to_tsquery('simple', ${query})`, ...cols.map((c) => ilike(c as never, like)))!;
}

function ownerMatch(column: unknown, owner: string, viewerId: string): SQL | undefined {
  if (!owner) return undefined;
  if (owner === "me") return eq(column as never, viewerId);
  if (owner === "none") return isNull(column as never);
  if (/^[0-9a-f-]{36}$/i.test(owner)) return eq(column as never, owner);
  return undefined;
}

// ── Companies ───────────────────────────────────────────────────────────────

export async function listCompanies(ctx: ModuleContext, f: Partial<ListFilter> = {}, limit = 200) {
  const where: (SQL | undefined)[] = [];
  if (f.q) where.push(textMatch(customerCompanies.search, [customerCompanies.name, customerCompanies.email, customerCompanies.website], f.q));
  if (f.tag) where.push(sql`${customerCompanies.tags} @> array[${f.tag}]::text[]`);
  where.push(ownerMatch(customerCompanies.ownerId, f.owner ?? "", ctx.viewer.id));
  return ctx.db
    .select({
      ...companyCols,
      ownerName: users.name,
      contactCount: sql<number>`(select count(*)::int from customers_contacts c where c.company_id = ${customerCompanies.id})`,
    })
    .from(customerCompanies)
    .leftJoin(users, eq(users.id, customerCompanies.ownerId))
    .where(and(...where))
    .orderBy(asc(sql`lower(${customerCompanies.name})`))
    .limit(limit);
}

export async function getCompany(q: Q, id: string): Promise<(Company & { ownerName: string | null }) | null> {
  const [row] = await q
    .select({ ...companyCols, ownerName: users.name })
    .from(customerCompanies)
    .leftJoin(users, eq(users.id, customerCompanies.ownerId))
    .where(eq(customerCompanies.id, id));
  return (row as Company & { ownerName: string | null }) ?? null;
}

/** The company with this name (case does not matter), created if there is none. */
export async function findOrCreateCompany(q: Q, name: string, by: Person, ownerId: string | null = null): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return null;
  const [found] = await q.select({ id: customerCompanies.id }).from(customerCompanies).where(eq(sql`lower(${customerCompanies.name})`, clean.toLowerCase())).limit(1);
  if (found) return found.id;
  const [made] = await q.insert(customerCompanies).values({ name: clean, ownerId, createdBy: by.id }).returning({ id: customerCompanies.id });
  return made.id;
}

export async function saveCompany(
  q: Q,
  input: Omit<CompanyInput, "custom"> & { custom: Record<string, string>; ownerId: string | null },
  by: Person,
  id: string | null,
  options: { sourceKey?: string } = {},
): Promise<Company> {
  await assertActiveUser(q, input.ownerId);
  const values = {
    name: input.name,
    website: input.website,
    email: input.email,
    phone: input.phone,
    address: input.address,
    notes: input.notes,
    tags: input.tags,
    custom: input.custom,
    ownerId: input.ownerId,
  };
  let row: Company;
  let previousOwner: string | null = null;
  if (id) {
    const before = await getCompany(q, id);
    if (!before) throw new UserError("This company no longer exists. It may have been deleted.");
    previousOwner = before.ownerId;
    [row] = (await q.update(customerCompanies).set({ ...values, updatedAt: new Date() }).where(eq(customerCompanies.id, id)).returning()) as Company[];
  } else {
    [row] = (await q.insert(customerCompanies).values({ ...values, createdBy: by.id, sourceKey: options.sourceKey ?? null }).returning()) as Company[];
    await audit(
      { actor: userActor(by), action: "customers.company_added", module: MODULE_ID, target: { type: "company", id: row.id }, summary: `${by.name} added the company "${row.name}".` },
      q,
    );
  }
  await tellNewOwner(by, row.ownerId, previousOwner, `the company ${row.name}`, `${BASE}/companies/${row.id}`);
  return row;
}

export async function deleteCompany(ctx: ModuleContext, id: string): Promise<void> {
  const [row] = await ctx.db.delete(customerCompanies).where(eq(customerCompanies.id, id)).returning({ name: customerCompanies.name });
  if (!row) throw new UserError("This company was already deleted.");
  await audit({ actor: userActor(ctx.viewer), action: "customers.company_deleted", module: MODULE_ID, target: { type: "company", id }, summary: `${ctx.viewer.name} deleted the company "${row.name}". Its contacts were kept.` });
}

// ── Contacts ────────────────────────────────────────────────────────────────

export type ContactRow = Contact & { companyName: string | null; ownerName: string | null };

export async function listContacts(ctx: ModuleContext, f: Partial<ListFilter> = {}, limit = 200): Promise<ContactRow[]> {
  const where: (SQL | undefined)[] = [];
  if (f.q) where.push(textMatch(customerContacts.search, [customerContacts.name, customerContacts.email, customerContacts.phone], f.q));
  if (f.tag) where.push(sql`${customerContacts.tags} @> array[${f.tag}]::text[]`);
  where.push(ownerMatch(customerContacts.ownerId, f.owner ?? "", ctx.viewer.id));
  return (await ctx.db
    .select({ ...contactCols, companyName: customerCompanies.name, ownerName: users.name })
    .from(customerContacts)
    .leftJoin(customerCompanies, eq(customerCompanies.id, customerContacts.companyId))
    .leftJoin(users, eq(users.id, customerContacts.ownerId))
    .where(and(...where))
    .orderBy(asc(sql`lower(${customerContacts.name})`))
    .limit(limit)) as ContactRow[];
}

export async function getContact(q: Q, id: string): Promise<ContactRow | null> {
  const [row] = await q
    .select({ ...contactCols, companyName: customerCompanies.name, ownerName: users.name })
    .from(customerContacts)
    .leftJoin(customerCompanies, eq(customerCompanies.id, customerContacts.companyId))
    .leftJoin(users, eq(users.id, customerContacts.ownerId))
    .where(eq(customerContacts.id, id));
  return (row as ContactRow) ?? null;
}

export async function contactsOfCompany(q: Q, companyId: string) {
  return q
    .select({ id: customerContacts.id, name: customerContacts.name, email: customerContacts.email, phone: customerContacts.phone, jobTitle: customerContacts.jobTitle })
    .from(customerContacts)
    .where(eq(customerContacts.companyId, companyId))
    .orderBy(asc(customerContacts.name));
}

export interface ContactValues {
  name: string;
  email: string;
  phone: string;
  jobTitle: string;
  companyName: string;
  address: string;
  notes: string;
  tags: string[];
  custom: Record<string, string>;
  ownerId: string | null;
}

/** Creates (id null) or updates a contact. The company is found by name or created. */
export async function saveContact(q: Q, input: ContactValues, by: Person, id: string | null, options: { sourceKey?: string; via?: string } = {}): Promise<Contact> {
  await assertActiveUser(q, input.ownerId);
  const companyId = await findOrCreateCompany(q, input.companyName, by, input.ownerId);
  const values = {
    name: input.name,
    email: input.email,
    phone: input.phone,
    jobTitle: input.jobTitle,
    companyId,
    address: input.address,
    notes: input.notes,
    tags: input.tags,
    custom: input.custom,
    ownerId: input.ownerId,
    emailKey: emailKey(input.email),
    phoneKey: phoneKey(input.phone),
    nameKey: nameKey(input.name),
  };
  let row: Contact;
  let previousOwner: string | null = null;
  if (id) {
    const [before] = await q.select({ ownerId: customerContacts.ownerId }).from(customerContacts).where(eq(customerContacts.id, id));
    if (!before) throw new UserError("This contact no longer exists. It may have been deleted or merged.");
    previousOwner = before.ownerId;
    [row] = (await q.update(customerContacts).set({ ...values, updatedAt: new Date() }).where(eq(customerContacts.id, id)).returning()) as Contact[];
  } else {
    [row] = (await q.insert(customerContacts).values({ ...values, createdBy: by.id, sourceKey: options.sourceKey ?? null }).returning()) as Contact[];
    await audit(
      {
        actor: userActor(by),
        action: "customers.contact_added",
        module: MODULE_ID,
        target: { type: "contact", id: row.id },
        summary: `${by.name} added the contact "${row.name}"${options.via === "import" ? " (imported, approved)" : ""}.`,
      },
      q,
    );
  }
  await tellNewOwner(by, row.ownerId, previousOwner, `the contact ${row.name}`, `${BASE}/contacts/${row.id}`);
  return row;
}

export function contactValues(c: ContactRow): ContactValues {
  return {
    name: c.name,
    email: c.email,
    phone: c.phone,
    jobTitle: c.jobTitle,
    companyName: c.companyName ?? "",
    address: c.address,
    notes: c.notes,
    tags: c.tags,
    custom: c.custom,
    ownerId: c.ownerId,
  };
}

export async function deleteContact(ctx: ModuleContext, id: string): Promise<void> {
  const [row] = await ctx.db.delete(customerContacts).where(eq(customerContacts.id, id)).returning({ name: customerContacts.name });
  if (!row) throw new UserError("This contact was already deleted.");
  await audit({ actor: userActor(ctx.viewer), action: "customers.contact_deleted", module: MODULE_ID, target: { type: "contact", id }, summary: `${ctx.viewer.name} deleted the contact "${row.name}" and its timeline.` });
}

/** Contacts that could be the same person (for duplicate detection). */
export async function possibleMatches(q: Q, keys: { emails: string[]; phones: string[]; names: string[] }) {
  const conds: SQL[] = [];
  if (keys.emails.length) conds.push(inArray(customerContacts.emailKey, keys.emails));
  if (keys.phones.length) conds.push(inArray(customerContacts.phoneKey, keys.phones));
  if (keys.names.length) conds.push(inArray(customerContacts.nameKey, keys.names));
  if (!conds.length) return [];
  return q
    .select({
      id: customerContacts.id,
      name: customerContacts.name,
      email: customerContacts.email,
      phone: customerContacts.phone,
      emailKey: customerContacts.emailKey,
      phoneKey: customerContacts.phoneKey,
      nameKey: customerContacts.nameKey,
    })
    .from(customerContacts)
    .where(or(...conds))
    .orderBy(asc(customerContacts.createdAt));
}

// ── Stages and deals ────────────────────────────────────────────────────────

export const DEFAULT_STAGES: { name: string; kind: "open" | "won" | "lost" }[] = [
  { name: "New lead", kind: "open" },
  { name: "Talking", kind: "open" },
  { name: "Quote sent", kind: "open" },
  { name: "Won", kind: "won" },
  { name: "Lost", kind: "lost" },
];

export async function listStages(q: Q): Promise<Stage[]> {
  const rows = await q.select().from(customerStages).orderBy(asc(customerStages.position), asc(customerStages.createdAt));
  if (rows.length) return rows;
  // First use: a pipeline to start from; the owner renames it in Pipeline settings.
  await q.insert(customerStages).values(DEFAULT_STAGES.map((s, i) => ({ ...s, position: i }))).onConflictDoNothing();
  return q.select().from(customerStages).orderBy(asc(customerStages.position));
}

export async function saveStage(ctx: ModuleContext, input: { id: string | null; name: string; kind: "open" | "won" | "lost" }): Promise<void> {
  if (input.id) {
    const [row] = await ctx.db.update(customerStages).set({ name: input.name, kind: input.kind }).where(eq(customerStages.id, input.id)).returning();
    if (!row) throw new UserError("This stage no longer exists. Reload the page.");
  } else {
    const stages = await listStages(ctx.db);
    if (stages.length >= 15) throw new UserError("A pipeline can have at most 15 stages. Remove one first.");
    await ctx.db.insert(customerStages).values({ name: input.name, kind: input.kind, position: stages.length });
  }
  await audit({ actor: userActor(ctx.viewer), action: "customers.pipeline_changed", module: MODULE_ID, summary: `${ctx.viewer.name} ${input.id ? "changed" : "added"} the pipeline stage "${input.name}".` });
}

export async function moveStage(ctx: ModuleContext, id: string, direction: "up" | "down"): Promise<void> {
  const stages = await listStages(ctx.db);
  const i = stages.findIndex((s) => s.id === id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= stages.length) return;
  [stages[i], stages[j]] = [stages[j], stages[i]];
  await ctx.db.transaction(async (tx) => {
    for (const [position, s] of stages.entries()) await tx.update(customerStages).set({ position }).where(eq(customerStages.id, s.id));
  });
}

export async function deleteStage(ctx: ModuleContext, id: string): Promise<void> {
  const [{ n }] = await ctx.db.select({ n: count() }).from(customerDeals).where(eq(customerDeals.stageId, id));
  if (n > 0) throw new UserError(`This stage still has ${n} deal${n === 1 ? "" : "s"}. Move them to another stage first.`);
  const stages = await listStages(ctx.db);
  if (stages.length <= 2) throw new UserError("Keep at least two stages in the pipeline.");
  const [row] = await ctx.db.delete(customerStages).where(eq(customerStages.id, id)).returning({ name: customerStages.name });
  if (row) await audit({ actor: userActor(ctx.viewer), action: "customers.pipeline_changed", module: MODULE_ID, summary: `${ctx.viewer.name} removed the pipeline stage "${row.name}".` });
}

export type DealRow = Deal & { contactName: string | null; companyName: string | null; ownerName: string | null; stageName: string; stageKind: "open" | "won" | "lost" };

const dealSelect = {
  ...dealCols,
  contactName: customerContacts.name,
  companyName: customerCompanies.name,
  ownerName: users.name,
  stageName: customerStages.name,
  stageKind: customerStages.kind,
};

export async function listDeals(ctx: ModuleContext, f: Partial<ListFilter> & { contactId?: string; companyId?: string } = {}, limit = 500): Promise<DealRow[]> {
  const where: (SQL | undefined)[] = [];
  if (f.q) where.push(textMatch(customerDeals.search, [customerDeals.title], f.q));
  where.push(ownerMatch(customerDeals.ownerId, f.owner ?? "", ctx.viewer.id));
  if (f.stage && /^[0-9a-f-]{36}$/i.test(f.stage)) where.push(eq(customerDeals.stageId, f.stage));
  if (f.status) where.push(eq(customerStages.kind, f.status));
  if (f.contactId) where.push(eq(customerDeals.contactId, f.contactId));
  if (f.companyId) where.push(eq(customerDeals.companyId, f.companyId));
  return (await ctx.db
    .select(dealSelect)
    .from(customerDeals)
    .innerJoin(customerStages, eq(customerStages.id, customerDeals.stageId))
    .leftJoin(customerContacts, eq(customerContacts.id, customerDeals.contactId))
    .leftJoin(customerCompanies, eq(customerCompanies.id, customerDeals.companyId))
    .leftJoin(users, eq(users.id, customerDeals.ownerId))
    .where(and(...where))
    .orderBy(desc(customerDeals.updatedAt))
    .limit(limit)) as DealRow[];
}

export async function getDeal(q: Q, id: string): Promise<DealRow | null> {
  const [row] = await q
    .select(dealSelect)
    .from(customerDeals)
    .innerJoin(customerStages, eq(customerStages.id, customerDeals.stageId))
    .leftJoin(customerContacts, eq(customerContacts.id, customerDeals.contactId))
    .leftJoin(customerCompanies, eq(customerCompanies.id, customerDeals.companyId))
    .leftJoin(users, eq(users.id, customerDeals.ownerId))
    .where(eq(customerDeals.id, id));
  return (row as DealRow) ?? null;
}

export interface DealValues {
  title: string;
  stageId: string;
  contactId: string | null;
  companyId: string | null;
  valueCents: number | null;
  expectedClose: string | null;
  notes: string;
  custom: Record<string, string>;
  ownerId: string | null;
}

export async function saveDeal(q: Q, input: DealValues, by: Person, id: string | null, options: { sourceKey?: string } = {}): Promise<Deal> {
  await assertActiveUser(q, input.ownerId);
  const [stage] = await q.select().from(customerStages).where(eq(customerStages.id, input.stageId));
  if (!stage) throw new UserError("That pipeline stage no longer exists. Reload the page and pick another.");
  // A deal for a contact belongs to the contact's company unless one is chosen.
  let companyId = input.companyId;
  if (!companyId && input.contactId) {
    const [c] = await q.select({ companyId: customerContacts.companyId }).from(customerContacts).where(eq(customerContacts.id, input.contactId));
    if (!c) throw new UserError("That contact no longer exists. Pick another.");
    companyId = c.companyId;
  }
  const values = { ...input, companyId, closedAt: stage.kind === "open" ? null : new Date() };
  if (id) {
    const before = await getDeal(q, id);
    if (!before) throw new UserError("This deal no longer exists. It may have been deleted.");
    const [row] = (await q
      .update(customerDeals)
      .set({ ...values, closedAt: before.stageId === input.stageId ? before.closedAt : values.closedAt, updatedAt: new Date() })
      .where(eq(customerDeals.id, id))
      .returning()) as Deal[];
    if (before.stageId !== input.stageId) await logStageChange(q, row, before.stageName, stage, by, "user");
    await tellNewOwner(by, row.ownerId, before.ownerId, `the deal ${row.title}`, `${BASE}/deals/${row.id}`);
    return row;
  }
  const [row] = (await q.insert(customerDeals).values({ ...values, createdBy: by.id, sourceKey: options.sourceKey ?? null }).returning()) as Deal[];
  await audit({ actor: userActor(by), action: "customers.deal_added", module: MODULE_ID, target: { type: "deal", id: row.id }, summary: `${by.name} added the deal "${row.title}" in ${stage.name}.` }, q);
  await tellNewOwner(by, row.ownerId, null, `the deal ${row.title}`, `${BASE}/deals/${row.id}`);
  return row;
}

async function logStageChange(q: Q, deal: Deal, fromName: string, to: Stage, by: Person, via: string, sourceKey?: string): Promise<void> {
  await q.insert(customerActivities).values({
    kind: "stage_change",
    body: `Moved from ${fromName} to ${to.name}.`,
    dealId: deal.id,
    authorId: by.id,
    authorName: by.name,
    via,
    sourceKey: sourceKey ?? null,
  });
  await audit(
    {
      actor: userActor(by),
      action: "customers.deal_stage",
      module: MODULE_ID,
      target: { type: "deal", id: deal.id },
      summary: `${by.name} moved the deal "${deal.title}" from ${fromName} to ${to.name}${via === "ai" ? " (proposed by the assistant, approved)" : ""}.`,
      visibility: to.kind === "won" ? "everyone" : "admins",
    },
    q,
  );
}

/** Moves a deal to another stage and records it on the timeline. Returns false when it was already there. */
export async function setDealStage(q: Q, dealId: string, stageId: string, by: Person, via = "user", sourceKey?: string): Promise<{ deal: DealRow; changed: boolean; stage: Stage }> {
  const deal = await getDeal(q, dealId);
  if (!deal) throw new UserError("This deal no longer exists. It may have been deleted.");
  const [stage] = await q.select().from(customerStages).where(eq(customerStages.id, stageId));
  if (!stage) throw new UserError("That pipeline stage no longer exists. Reload the page and pick another.");
  if (deal.stageId === stageId) return { deal, changed: false, stage };
  const [row] = (await q
    .update(customerDeals)
    .set({ stageId, closedAt: stage.kind === "open" ? null : new Date(), updatedAt: new Date() })
    .where(eq(customerDeals.id, dealId))
    .returning()) as Deal[];
  await logStageChange(q, row, deal.stageName, stage, by, via, sourceKey);
  return { deal: { ...deal, ...row, stageName: stage.name, stageKind: stage.kind }, changed: true, stage };
}

export async function deleteDeal(ctx: ModuleContext, id: string): Promise<void> {
  const [row] = await ctx.db.delete(customerDeals).where(eq(customerDeals.id, id)).returning({ title: customerDeals.title });
  if (!row) throw new UserError("This deal was already deleted.");
  await audit({ actor: userActor(ctx.viewer), action: "customers.deal_deleted", module: MODULE_ID, target: { type: "deal", id }, summary: `${ctx.viewer.name} deleted the deal "${row.title}".` });
}

/** Open deals per stage with their total value, in pipeline order (closed stages count the last 30 days). */
export async function dealsByStage(q: Q): Promise<{ id: string; name: string; kind: "open" | "won" | "lost"; deals: number; valueCents: number }[]> {
  const stages = await listStages(q);
  const rows = await q
    .select({ stageId: customerDeals.stageId, n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${customerDeals.valueCents}), 0)::bigint` })
    .from(customerDeals)
    .innerJoin(customerStages, eq(customerStages.id, customerDeals.stageId))
    .where(or(eq(customerStages.kind, "open"), sql`${customerDeals.closedAt} > now() - interval '30 days'`))
    .groupBy(customerDeals.stageId);
  const by = new Map(rows.map((r) => [r.stageId, r]));
  return stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind, deals: by.get(s.id)?.n ?? 0, valueCents: Number(by.get(s.id)?.total ?? 0) }));
}

// ── Activities (the timeline) ───────────────────────────────────────────────

export async function addActivity(
  q: Q,
  input: { kind: ActivityKind; body: string; contactId: string | null; companyId: string | null; dealId: string | null; occurredAt?: Date },
  author: Person,
  options: { via?: string; sourceKey?: string } = {},
): Promise<Activity> {
  await assertSubjectExists(q, input);
  const [row] = (await q
    .insert(customerActivities)
    .values({
      kind: input.kind,
      body: input.body,
      contactId: input.contactId,
      companyId: input.companyId,
      dealId: input.dealId,
      occurredAt: input.occurredAt ?? new Date(),
      authorId: author.id,
      authorName: author.name,
      via: options.via ?? "user",
      sourceKey: options.sourceKey ?? null,
    })
    .returning()) as Activity[];
  return row;
}

export async function assertSubjectExists(q: Q, s: { contactId: string | null; companyId: string | null; dealId: string | null }): Promise<string> {
  if (s.contactId) {
    const c = await getContact(q, s.contactId);
    if (!c) throw new UserError("That contact no longer exists. It may have been deleted or merged.");
    return c.name;
  }
  if (s.companyId) {
    const c = await getCompany(q, s.companyId);
    if (!c) throw new UserError("That company no longer exists. It may have been deleted.");
    return c.name;
  }
  if (s.dealId) {
    const d = await getDeal(q, s.dealId);
    if (!d) throw new UserError("That deal no longer exists. It may have been deleted.");
    return d.title;
  }
  throw new UserError("Say which contact, company or deal this is about.");
}

export type TimelineEntry = Activity & { dealTitle: string | null; contactName: string | null };

/** Everything that happened with a contact, a company (and its people) or a deal, newest first. */
export async function timeline(q: Q, s: { contactId?: string; companyId?: string; dealId?: string }, limit = 100): Promise<TimelineEntry[]> {
  let where: SQL;
  if (s.contactId) {
    where = or(eq(customerActivities.contactId, s.contactId), sql`${customerActivities.dealId} in (select id from customers_deals where contact_id = ${s.contactId})`)!;
  } else if (s.companyId) {
    where = or(
      eq(customerActivities.companyId, s.companyId),
      sql`${customerActivities.contactId} in (select id from customers_contacts where company_id = ${s.companyId})`,
      sql`${customerActivities.dealId} in (select id from customers_deals where company_id = ${s.companyId})`,
    )!;
  } else if (s.dealId) {
    where = eq(customerActivities.dealId, s.dealId);
  } else return [];
  return (await q
    .select({ ...activityCols, dealTitle: customerDeals.title, contactName: customerContacts.name })
    .from(customerActivities)
    .leftJoin(customerDeals, eq(customerDeals.id, customerActivities.dealId))
    .leftJoin(customerContacts, eq(customerContacts.id, customerActivities.contactId))
    .where(where)
    .orderBy(desc(customerActivities.occurredAt), desc(customerActivities.createdAt))
    .limit(limit)) as TimelineEntry[];
}

// ── Follow-ups ──────────────────────────────────────────────────────────────

export type FollowUpRow = FollowUp & { assigneeName: string | null; contactName: string | null; companyName: string | null; dealTitle: string | null };

const followUpSelect = {
  id: customerFollowUps.id,
  title: customerFollowUps.title,
  notes: customerFollowUps.notes,
  dueOn: customerFollowUps.dueOn,
  contactId: customerFollowUps.contactId,
  companyId: customerFollowUps.companyId,
  dealId: customerFollowUps.dealId,
  assigneeId: customerFollowUps.assigneeId,
  status: customerFollowUps.status,
  via: customerFollowUps.via,
  taskApprovalId: customerFollowUps.taskApprovalId,
  taskId: customerFollowUps.taskId,
  notifiedAt: customerFollowUps.notifiedAt,
  doneAt: customerFollowUps.doneAt,
  createdBy: customerFollowUps.createdBy,
  createdAt: customerFollowUps.createdAt,
  sourceKey: customerFollowUps.sourceKey,
  assigneeName: users.name,
  contactName: customerContacts.name,
  companyName: customerCompanies.name,
  dealTitle: customerDeals.title,
};

export async function listFollowUps(
  q: Q,
  f: { assigneeId?: string; status?: "open" | "done" | "cancelled"; dueBy?: string; contactId?: string; companyId?: string; dealId?: string },
  limit = 200,
): Promise<FollowUpRow[]> {
  const where: (SQL | undefined)[] = [];
  if (f.assigneeId) where.push(eq(customerFollowUps.assigneeId, f.assigneeId));
  if (f.status) where.push(eq(customerFollowUps.status, f.status));
  if (f.dueBy) where.push(lte(customerFollowUps.dueOn, f.dueBy));
  if (f.contactId) where.push(eq(customerFollowUps.contactId, f.contactId));
  if (f.companyId) where.push(eq(customerFollowUps.companyId, f.companyId));
  if (f.dealId) where.push(eq(customerFollowUps.dealId, f.dealId));
  return (await q
    .select(followUpSelect)
    .from(customerFollowUps)
    .leftJoin(users, eq(users.id, customerFollowUps.assigneeId))
    .leftJoin(customerContacts, eq(customerContacts.id, customerFollowUps.contactId))
    .leftJoin(customerCompanies, eq(customerCompanies.id, customerFollowUps.companyId))
    .leftJoin(customerDeals, eq(customerDeals.id, customerFollowUps.dealId))
    .where(and(...where))
    .orderBy(asc(customerFollowUps.dueOn), asc(customerFollowUps.createdAt))
    .limit(limit)) as FollowUpRow[];
}

export function followUpSubjectUrl(f: { contactId: string | null; companyId: string | null; dealId: string | null }): string {
  if (f.contactId) return `${BASE}/contacts/${f.contactId}`;
  if (f.companyId) return `${BASE}/companies/${f.companyId}`;
  if (f.dealId) return `${BASE}/deals/${f.dealId}`;
  return `${BASE}/follow-ups`;
}

export async function insertFollowUp(
  q: Q,
  input: { title: string; notes: string; dueOn: string; contactId: string | null; companyId: string | null; dealId: string | null; assigneeId: string | null },
  by: Person,
  options: { via?: "here" | "tasks"; taskApprovalId?: string | null; taskId?: string | null; sourceKey?: string } = {},
): Promise<FollowUp> {
  await assertActiveUser(q, input.assigneeId);
  const about = await assertSubjectExists(q, input);
  const [row] = await q
    .insert(customerFollowUps)
    .values({
      ...input,
      via: options.via ?? "here",
      taskApprovalId: options.taskApprovalId ?? null,
      taskId: options.taskId ?? null,
      createdBy: by.id,
      sourceKey: options.sourceKey ?? null,
    })
    .returning();
  await audit(
    {
      actor: userActor(by),
      action: "customers.follow_up_added",
      module: MODULE_ID,
      target: { type: "follow_up", id: row.id },
      summary: `${by.name} set a follow-up for ${about}: "${row.title}", due ${row.dueOn}${row.via === "tasks" ? " (as a task in Tasks)" : ""}.`,
    },
    q,
  );
  return row;
}

export async function setFollowUpStatus(ctx: ModuleContext, id: string, status: "open" | "done" | "cancelled"): Promise<void> {
  const [row] = await ctx.db
    .update(customerFollowUps)
    .set({ status, doneAt: status === "open" ? null : new Date() })
    .where(eq(customerFollowUps.id, id))
    .returning({ title: customerFollowUps.title });
  if (!row) throw new UserError("This follow-up no longer exists.");
}

/**
 * Sends the "follow-up due" notification once per reminder that is due today
 * or overdue (claimed with one conditional UPDATE, so it is sent once even if
 * two pages load at the same moment). The suite has no scheduler; this runs
 * when the person's home page or this app loads.
 */
export async function deliverDueReminders(q: Q, viewerId: string, timeZone: string): Promise<number> {
  const today = todayIn(timeZone);
  const due = await q
    .update(customerFollowUps)
    .set({ notifiedAt: new Date() })
    .where(
      and(
        eq(customerFollowUps.assigneeId, viewerId),
        eq(customerFollowUps.status, "open"),
        eq(customerFollowUps.via, "here"),
        isNull(customerFollowUps.notifiedAt),
        lte(customerFollowUps.dueOn, today),
      ),
    )
    .returning({ id: customerFollowUps.id, title: customerFollowUps.title, dueOn: customerFollowUps.dueOn, contactId: customerFollowUps.contactId, companyId: customerFollowUps.companyId, dealId: customerFollowUps.dealId });
  for (const f of due) {
    await notify([viewerId], {
      kind: "customers.follow_up_due",
      title: `${f.dueOn < today ? "Overdue" : "Due today"}: ${f.title}`,
      url: followUpSubjectUrl(f),
    });
  }
  return due.length;
}

// ── Saved filters ───────────────────────────────────────────────────────────

export async function listSavedFilters(ctx: ModuleContext, entity: "contacts" | "companies" | "deals") {
  return ctx.db
    .select({ id: customerSavedFilters.id, name: customerSavedFilters.name, query: customerSavedFilters.query, shared: customerSavedFilters.shared, userId: customerSavedFilters.userId })
    .from(customerSavedFilters)
    .where(and(eq(customerSavedFilters.entity, entity), or(eq(customerSavedFilters.userId, ctx.viewer.id), eq(customerSavedFilters.shared, true))))
    .orderBy(asc(customerSavedFilters.name));
}

export function filterQueryString(query: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const k of ["q", "tag", "owner", "stage", "status"]) if (query[k]) params.set(k, query[k]);
  const s = params.toString();
  return s ? `?${s}` : "";
}

// ── Search ──────────────────────────────────────────────────────────────────

export async function searchCustomers(ctx: ModuleContext, query: string, limit: number): Promise<SearchHit[]> {
  const q = sql`websearch_to_tsquery('simple', ${query})`;
  const contacts = await ctx.db
    .select({
      id: customerContacts.id,
      title: customerContacts.name,
      at: customerContacts.updatedAt,
      rank: sql<number>`ts_rank(${customerContacts.search}, ${q})`,
      snippet: sql<string>`concat_ws(' · ', nullif(${customerContacts.jobTitle}, ''), nullif(${customerContacts.email}, ''), nullif(${customerContacts.phone}, ''))`,
    })
    .from(customerContacts)
    .where(sql`${customerContacts.search} @@ ${q}`)
    .orderBy(sql`4 desc`)
    .limit(limit);
  const companies = await ctx.db
    .select({
      id: customerCompanies.id,
      title: customerCompanies.name,
      at: customerCompanies.updatedAt,
      rank: sql<number>`ts_rank(${customerCompanies.search}, ${q})`,
      snippet: sql<string>`concat_ws(' · ', 'Company', nullif(${customerCompanies.website}, ''), nullif(${customerCompanies.email}, ''))`,
    })
    .from(customerCompanies)
    .where(sql`${customerCompanies.search} @@ ${q}`)
    .orderBy(sql`4 desc`)
    .limit(limit);
  const deals = await ctx.db
    .select({
      id: customerDeals.id,
      title: customerDeals.title,
      at: customerDeals.updatedAt,
      rank: sql<number>`ts_rank(${customerDeals.search}, ${q})`,
      snippet: sql<string>`'Deal · ' || ${customerStages.name}`,
    })
    .from(customerDeals)
    .innerJoin(customerStages, eq(customerStages.id, customerDeals.stageId))
    .where(sql`${customerDeals.search} @@ ${q}`)
    .orderBy(sql`4 desc`)
    .limit(limit);
  return [
    ...contacts.map((r) => ({ title: r.title, snippet: r.snippet, url: `${BASE}/contacts/${r.id}`, rank: Number(r.rank), at: r.at })),
    ...companies.map((r) => ({ title: r.title, snippet: r.snippet, url: `${BASE}/companies/${r.id}`, rank: Number(r.rank), at: r.at })),
    ...deals.map((r) => ({ title: r.title, snippet: r.snippet, url: `${BASE}/deals/${r.id}`, rank: Number(r.rank), at: r.at })),
  ]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
}

// ── For the assistant ───────────────────────────────────────────────────────

/** Contacts and companies matching a name, email, phone or word, as small JSON. */
export async function findCustomers(ctx: ModuleContext, query: string, limit = 10) {
  const [contacts, companies] = await Promise.all([listContacts(ctx, { q: query }, limit), listCompanies(ctx, { q: query }, limit)]);
  return {
    contacts: contacts.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, jobTitle: c.jobTitle, company: c.companyName, companyId: c.companyId, tags: c.tags, owner: c.ownerName })),
    companies: companies.map((c) => ({ id: c.id, name: c.name, website: c.website, email: c.email, phone: c.phone, contacts: c.contactCount, tags: c.tags, owner: c.ownerName })),
  };
}

/** A customer's record, deals, open follow-ups and timeline, for the assistant to summarise. */
export async function customerHistory(ctx: ModuleContext, s: { contactId?: string; companyId?: string }, limit = 40) {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const deals = await listDeals(ctx, s.contactId ? { contactId: s.contactId } : { companyId: s.companyId });
  const followUps = await listFollowUps(ctx.db, { ...(s.contactId ? { contactId: s.contactId } : { companyId: s.companyId }), status: "open" });
  const events = await timeline(ctx.db, s, limit);
  let record: Record<string, unknown> | null = null;
  if (s.contactId) {
    const c = await getContact(ctx.db, s.contactId);
    if (c) record = { type: "contact", id: c.id, name: c.name, email: c.email, phone: c.phone, jobTitle: c.jobTitle, company: c.companyName, tags: c.tags, owner: c.ownerName, notes: c.notes, custom: c.custom, since: iso(c.createdAt) };
  } else if (s.companyId) {
    const c = await getCompany(ctx.db, s.companyId);
    if (c) {
      const people = await contactsOfCompany(ctx.db, c.id);
      record = { type: "company", id: c.id, name: c.name, website: c.website, email: c.email, phone: c.phone, tags: c.tags, owner: c.ownerName, notes: c.notes, custom: c.custom, contacts: people.map((p) => ({ id: p.id, name: p.name, jobTitle: p.jobTitle })), since: iso(c.createdAt) };
    }
  }
  if (!record) return { error: "No contact or company has that id. Use find_customers to look it up first." };
  return {
    record,
    deals: deals.map((d) => ({ id: d.id, title: d.title, stage: d.stageName, status: d.stageKind, value: formatMoney(d.valueCents) || null, expectedClose: d.expectedClose, owner: d.ownerName })),
    openFollowUps: followUps.map((f) => ({ id: f.id, title: f.title, dueOn: f.dueOn, assignee: f.assigneeName })),
    timeline: events.map((e) => ({ kind: e.kind, at: iso(e.occurredAt), by: e.authorName, deal: e.dealTitle, text: e.body.slice(0, 600) })),
  };
}

/** The contacts' and companies' names, for the assistant's name references (newest first). */
export async function knownCustomerNames(ctx: ModuleContext): Promise<string[]> {
  if (!ctx.can(P.access)) return [];
  const [contacts, companies] = await Promise.all([
    ctx.db.select({ name: customerContacts.name }).from(customerContacts).orderBy(desc(customerContacts.updatedAt)).limit(5000),
    ctx.db.select({ name: customerCompanies.name }).from(customerCompanies).orderBy(desc(customerCompanies.updatedAt)).limit(5000),
  ]);
  return [...contacts, ...companies].map((r) => r.name);
}

/**
 * How given deals stand now (stage, open/won/lost, value, contact), for other
 * apps through the `deal_outcomes` read tool: Leads reads whether a converted
 * lead's deal was won. Unknown ids are left out.
 */
export async function dealOutcomes(q: Q, ids: string[]) {
  const wanted = [...new Set(ids)].filter((i) => /^[0-9a-f-]{36}$/i.test(i));
  if (!wanted.length) return [];
  const rows = await q
    .select({
      id: customerDeals.id,
      title: customerDeals.title,
      contactId: customerDeals.contactId,
      contactName: customerContacts.name,
      stage: customerStages.name,
      status: customerStages.kind,
      valueCents: customerDeals.valueCents,
      closedAt: customerDeals.closedAt,
    })
    .from(customerDeals)
    .innerJoin(customerStages, eq(customerStages.id, customerDeals.stageId))
    .leftJoin(customerContacts, eq(customerContacts.id, customerDeals.contactId))
    .where(inArray(customerDeals.id, wanted));
  return rows.map((r) => ({ ...r, value: formatMoney(r.valueCents) || null, closedAt: r.closedAt ? r.closedAt.toISOString() : null }));
}

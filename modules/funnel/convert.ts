import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { approve, canDecide, propose } from "@/lib/approvals/ledger";
import { audit, userActor } from "@/lib/audit";
import { approvalItems, approvals, users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { ModuleContext, ReadTool, WriteAction } from "@/lib/modules/contract";
import { enabledModules, findModule } from "@/lib/modules/registry-access";
import { addEvent, getLead, leadUrl, MODULE_ID, stopSequences, type LeadRow } from "./data";
import { SOURCE_LABELS, type LeadSource } from "./logic";
import { funnelLeads } from "./schema";

/**
 * Converting a lead into a customer, through the Customers app's registered
 * write action `customers.create_deal` only (never its tables or code), and
 * only when Customers is installed and switched on. The action finds or
 * merges the contact with Customers' own duplicate detection and adds a deal
 * in the first open stage; the ids it returns are kept on the lead. Whether
 * that deal was won is read back through Customers' read tool `deal_outcomes`.
 */

export const CUSTOMERS = "customers";
const CREATE_DEAL = "create_deal";
const OUTCOMES_TOOL = "deal_outcomes";

export const CUSTOMERS_OFF =
  "Customers is switched off or not installed, so a lead cannot be converted into a customer. The owner can switch it on in Settings → Apps; until then, keep working the lead here.";

export interface CustomersLink {
  fullName: string;
  action: WriteAction<unknown>;
}

/** True when this build has Customers with its "add a deal with its contact" action (it may still be switched off). */
export function customersInstalled(): boolean {
  return Boolean(findModule(CUSTOMERS)?.actions?.some((a) => a.name === CREATE_DEAL));
}

/** Customers' create-deal action, when Customers is installed and switched on. */
export async function customersLink(): Promise<CustomersLink | null> {
  const action = findModule(CUSTOMERS)?.actions?.find((a) => a.name === CREATE_DEAL) as WriteAction<unknown> | undefined;
  if (!action) return null;
  const on = (await enabledModules()).some((m) => m.id === CUSTOMERS);
  return on ? { fullName: `${CUSTOMERS}.${CREATE_DEAL}`, action } : null;
}

/** Where the lead came from, as one line for the deal's notes and the report. */
export function sourceLine(lead: Pick<LeadRow, "source" | "sourceDetail" | "utmSource" | "utmMedium" | "utmCampaign" | "pageUrl">): string {
  const parts = [`Leads: ${SOURCE_LABELS[lead.source as LeadSource]}${lead.sourceDetail ? ` “${lead.sourceDetail}”` : ""}`];
  const utm = [lead.utmSource && `utm_source=${lead.utmSource}`, lead.utmMedium && `utm_medium=${lead.utmMedium}`, lead.utmCampaign && `utm_campaign=${lead.utmCampaign}`].filter(Boolean);
  if (utm.length) parts.push(utm.join(", "));
  if (lead.pageUrl) parts.push(`page ${lead.pageUrl.slice(0, 120)}`);
  return parts.join("; ").slice(0, 300);
}

/** The record Customers' create_deal takes for this lead (its schema is the source of truth; a unit test parses it). */
export function dealInputFor(lead: LeadRow, ownerEmail: string): Record<string, unknown> {
  return {
    title: `${lead.service || "Enquiry"}: ${lead.name}`.slice(0, 200),
    contact: {
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      companyName: lead.company,
      jobTitle: "",
      address: "",
      notes: lead.message ? `From a lead: ${lead.message}`.slice(0, 5000) : "",
      tags: ["lead"],
      ownerEmail: "",
      custom: {},
    },
    valueCents: null,
    notes: lead.message.slice(0, 4000),
    source: sourceLine(lead),
    ownerEmail,
  };
}

export type ConversionState = "converted" | "waiting" | "failed" | "declined" | "none";

/**
 * Reads the outcome of the lead's conversion approval and, once Customers has
 * written the deal, marks the lead converted with the ids (once: the UPDATE
 * only matches while no deal is recorded).
 */
export async function settleConversion(ctx: ModuleContext, lead: LeadRow): Promise<{ state: ConversionState; error?: string }> {
  if (lead.customerDealId) return { state: "converted" };
  if (!lead.conversionApprovalId) return { state: "none" };
  const [approval] = await ctx.db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, lead.conversionApprovalId));
  const [item] = await ctx.db.select({ status: approvalItems.status, result: approvalItems.result, error: approvalItems.error }).from(approvalItems).where(eq(approvalItems.approvalId, lead.conversionApprovalId));
  if (!approval || !item) return { state: "none" };
  if (approval.status === "declined" || item.status === "skipped") {
    await ctx.db
      .update(funnelLeads)
      .set({ conversionApprovalId: null, conversionAttempt: sql`${funnelLeads.conversionAttempt} + 1` })
      .where(and(eq(funnelLeads.id, lead.id), eq(funnelLeads.conversionApprovalId, lead.conversionApprovalId)));
    await addEvent(ctx.db, lead.id, "converted", "The conversion into a customer was declined in Approvals. The lead stays here.", "Approvals");
    return { state: "declined" };
  }
  if (item.status === "failed") return { state: "failed", error: item.error ?? "" };
  if (item.status !== "applied") return { state: "waiting" };

  const dealId = (item.result as { targetId?: string | null } | null)?.targetId ?? null;
  const summary = (item.result as { summary?: string | null } | null)?.summary ?? "";
  if (!dealId) return { state: "failed", error: "Customers did not say which deal it added." };
  const outcome = (await dealOutcomes(ctx, [dealId]))?.get(dealId);
  const now = new Date();
  const [marked] = await ctx.db
    .update(funnelLeads)
    .set({ status: "converted", convertedAt: now, customerDealId: dealId, customerContactId: outcome?.contactId ?? null, updatedAt: now })
    .where(and(eq(funnelLeads.id, lead.id), isNull(funnelLeads.customerDealId)))
    .returning({ id: funnelLeads.id });
  if (marked) {
    await addEvent(ctx.db, lead.id, "converted", `Converted into a customer. Customers: ${summary || "deal added"}.`, ctx.viewer);
    await stopSequences(ctx.db, lead.id, "the lead was converted");
    await audit({ actor: userActor(ctx.viewer), action: "funnel.converted", module: MODULE_ID, target: { type: "lead", id: lead.id }, summary: `The lead "${lead.name}" was converted into a customer (${summary || "deal added"}).`, visibility: "everyone" });
  }
  return { state: "converted" };
}

/**
 * One click: proposes the deal (and its contact) to Customers' action as the
 * person, and approves it at once when they may decide it. Otherwise it waits
 * in Approvals and the lead is marked converted when it is approved.
 */
export async function convertLead(ctx: ModuleContext, leadId: string): Promise<{ state: ConversionState; message: string; approvalId?: string }> {
  const link = await customersLink();
  if (!link) throw new UserError(CUSTOMERS_OFF);
  let lead = await getLead(ctx.db, leadId);
  if (!lead) throw new UserError("This lead no longer exists. It may have been deleted.");
  if (lead.status === "converted" || lead.customerDealId) return { state: "converted", message: `${lead.name} is already a customer.` };
  if (lead.status === "disqualified") throw new UserError(`${lead.name} is disqualified. Move the lead back to New or Qualified first if they are a real prospect.`);

  if (lead.conversionApprovalId) {
    const now = await settleConversion(ctx, lead);
    if (now.state === "converted") return { state: "converted", message: `${lead.name} is now a customer.` };
    if (now.state === "waiting") return { state: "waiting", message: "The conversion already waits in Approvals.", approvalId: lead.conversionApprovalId };
    if (now.state === "failed") throw new UserError(`Customers could not add it: ${now.error}. Fix that, then use “Retry failed” on the approval.`);
    lead = (await getLead(ctx.db, leadId))!;
  }

  const ownerEmail = lead.assigneeId ? ((await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, lead.assigneeId)))[0]?.email ?? ctx.viewer.email) : ctx.viewer.email;
  const input = dealInputFor(lead, ownerEmail);
  const parsed = link.action.input.safeParse(input);
  if (!parsed.success) throw new UserError(`Customers cannot take this lead as it is: ${parsed.error.issues[0]?.message ?? "a field is not accepted"}. Correct the lead, then convert it again.`);

  const key = `funnel:convert:${lead.id}:${lead.conversionAttempt}`;
  const result = await propose({
    action: link.fullName,
    items: [input],
    source: "user",
    requestedBy: ctx.viewer,
    title: `Customer from Leads: ${lead.name}`,
    note: `${ctx.viewer.name} converted the lead ${lead.name} in Leads (${sourceLine(lead)}).`,
    keys: [key],
  });
  let approvalId = result.approvalId;
  if (!approvalId) {
    // Already proposed (a double click): pick up that approval.
    const [existing] = await ctx.db.select({ approvalId: approvalItems.approvalId }).from(approvalItems).where(and(eq(approvalItems.action, link.fullName), eq(approvalItems.dedupeKey, key)));
    approvalId = existing?.approvalId ?? null;
  }
  if (!approvalId) throw new UserError("Customers did not accept the conversion. Reload the page and try again.");
  await ctx.db.update(funnelLeads).set({ conversionApprovalId: approvalId }).where(eq(funnelLeads.id, lead.id));
  lead = { ...lead, conversionApprovalId: approvalId };

  if (await canDecide(ctx.viewer, { action: link.fullName, requestedBy: ctx.viewer.id })) {
    const report = await approve(approvalId, ctx.viewer);
    if (report.status === "applied" || report.totals.applied > 0) {
      await settleConversion(ctx, lead);
      return { state: "converted", message: `${lead.name} is now a customer: the contact and a deal are in Customers.`, approvalId };
    }
    const why = report.failures[0]?.error ?? "it could not be written";
    throw new UserError(`Customers could not add it: ${why}. Fix that, then use “Retry failed” on the approval (/approvals/${approvalId}).`);
  }
  await addEvent(ctx.db, lead.id, "converted", `${ctx.viewer.name} asked to convert the lead into a customer; it waits in Approvals.`, ctx.viewer);
  return { state: "waiting", message: "Sent to Approvals: your role cannot add customers directly. The lead is marked converted once someone approves it.", approvalId };
}

export interface DealOutcome {
  id: string;
  contactId: string | null;
  status: "open" | "won" | "lost";
  stage: string;
  valueCents: number | null;
  closedAt: string | null;
}

/** How the given deals stand in Customers (its `deal_outcomes` read tool), or null when Customers is off or the viewer may not read it. */
export async function dealOutcomes(ctx: ModuleContext, dealIds: string[]): Promise<Map<string, DealOutcome> | null> {
  const mod = findModule(CUSTOMERS);
  const tool = mod?.aiTools?.find((t) => t.kind === "read" && t.name === OUTCOMES_TOOL) as ReadTool<unknown> | undefined;
  if (!mod || !tool) return null;
  if (!(await enabledModules()).some((m) => m.id === CUSTOMERS)) return null;
  if (!ctx.can(tool.permission)) return null;
  const out = new Map<string, DealOutcome>();
  const ids = [...new Set(dealIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const rows = (await tool.run({ ...ctx, moduleId: CUSTOMERS }, tool.input.parse({ dealIds: ids.slice(i, i + 500) }))) as DealOutcome[];
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

export const customerContactUrl = (id: string) => `/m/${CUSTOMERS}/contacts/${id}`;
export const customerDealUrl = (id: string) => `/m/${CUSTOMERS}/deals/${id}`;
export { leadUrl };

import "server-only";
import { and, sql } from "drizzle-orm";
import type { ModuleContext } from "@/lib/modules/contract";
import { dealOutcomes } from "./convert";
import { todayIn } from "./data";
import { median, minutesBetween, percent, SOURCE_LABELS, type LeadSource } from "./logic";
import { funnelLeads } from "./schema";
import type { ReportFilter } from "./schemas";

/**
 * The funnel report: leads that came in between two dates (in the business's
 * timezone), how far each got (contacted, qualified, converted), whether the
 * deal in Customers was won and for how much, and the median speed to lead,
 * per source. A lead counts at every step it reached, so the numbers only
 * go down from left to right.
 */

export interface FunnelCounts {
  leads: number;
  contacted: number;
  qualified: number;
  converted: number;
  won: number;
  disqualified: number;
  wonValueCents: number;
  /** Median minutes from coming in to the first contact (imported leads left out). */
  medianMinutes: number | null;
}

export interface ReportRow extends FunnelCounts {
  key: string;
  label: string;
}

export interface FunnelReport {
  from: string;
  to: string;
  group: ReportFilter["group"];
  rows: ReportRow[];
  total: FunnelCounts;
  /** False when Customers is off or the viewer may not read it: won and won value are unknown. */
  wonKnown: boolean;
}

export const GROUP_LABELS: Record<ReportFilter["group"], string> = { source: "Source", utm_source: "utm_source", utm_campaign: "utm_campaign" };

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The date range asked for, or the last 30 days; kept to at most three years, in order. */
export function reportRange(filter: ReportFilter, timeZone: string, now = new Date()): { from: string; to: string } {
  const today = todayIn(timeZone, now);
  let to = filter.to || today;
  let from = filter.from || shiftDate(to, -29);
  if (from > to) [from, to] = [to, from];
  if (from < shiftDate(to, -3 * 366)) from = shiftDate(to, -3 * 366);
  return { from, to };
}

/** The steps' conversion between each other, in whole per cent (null when the step before is empty). */
export function stepRates(c: FunnelCounts) {
  return {
    contacted: percent(c.contacted, c.leads),
    qualified: percent(c.qualified, c.contacted),
    converted: percent(c.converted, c.qualified),
    won: percent(c.won, c.converted),
  };
}

type Row = {
  id: string;
  source: string;
  sourceDetail: string;
  utmSource: string;
  utmCampaign: string;
  createdAt: Date;
  firstContactAt: Date | null;
  qualifiedAt: Date | null;
  convertedAt: Date | null;
  disqualifiedAt: Date | null;
  status: string;
  customerDealId: string | null;
};

function groupOf(r: Row, group: ReportFilter["group"]): { key: string; label: string } {
  if (group === "utm_source") return r.utmSource ? { key: `u:${r.utmSource.toLowerCase()}`, label: r.utmSource } : { key: "u:", label: "(no utm_source)" };
  if (group === "utm_campaign") return r.utmCampaign ? { key: `c:${r.utmCampaign.toLowerCase()}`, label: r.utmCampaign } : { key: "c:", label: "(no utm_campaign)" };
  if (r.source === "form") return { key: `form:${r.sourceDetail}`, label: `Web form “${r.sourceDetail || "(removed)"}”` };
  return { key: r.source, label: SOURCE_LABELS[r.source as LeadSource] ?? r.source };
}

function count(rows: Row[], outcomes: Map<string, { status: string; valueCents: number | null }> | null): FunnelCounts {
  const reached = (r: Row, step: "contacted" | "qualified" | "converted") =>
    step === "converted" ? Boolean(r.convertedAt) : step === "qualified" ? Boolean(r.qualifiedAt || r.convertedAt) : Boolean(r.firstContactAt || r.qualifiedAt || r.convertedAt);
  const won = rows.filter((r) => r.customerDealId && outcomes?.get(r.customerDealId)?.status === "won");
  return {
    leads: rows.length,
    contacted: rows.filter((r) => reached(r, "contacted")).length,
    qualified: rows.filter((r) => reached(r, "qualified")).length,
    converted: rows.filter((r) => reached(r, "converted")).length,
    won: won.length,
    disqualified: rows.filter((r) => r.status === "disqualified").length,
    wonValueCents: won.reduce((sum, r) => sum + (outcomes?.get(r.customerDealId!)?.valueCents ?? 0), 0),
    medianMinutes: median(rows.filter((r) => r.source !== "import" && r.firstContactAt).map((r) => minutesBetween(r.createdAt, r.firstContactAt)!)),
  };
}

export async function funnelReport(ctx: ModuleContext, filter: ReportFilter): Promise<FunnelReport> {
  const tz = ctx.business.timezone;
  const { from, to } = reportRange(filter, tz);
  const rows: Row[] = await ctx.db
    .select({
      id: funnelLeads.id,
      source: funnelLeads.source,
      sourceDetail: funnelLeads.sourceDetail,
      utmSource: funnelLeads.utmSource,
      utmCampaign: funnelLeads.utmCampaign,
      createdAt: funnelLeads.createdAt,
      firstContactAt: funnelLeads.firstContactAt,
      qualifiedAt: funnelLeads.qualifiedAt,
      convertedAt: funnelLeads.convertedAt,
      disqualifiedAt: funnelLeads.disqualifiedAt,
      status: funnelLeads.status,
      customerDealId: funnelLeads.customerDealId,
    })
    .from(funnelLeads)
    .where(and(sql`(${funnelLeads.createdAt} at time zone ${tz})::date >= ${from}::date`, sql`(${funnelLeads.createdAt} at time zone ${tz})::date <= ${to}::date`));
  const dealIds = rows.map((r) => r.customerDealId).filter((x): x is string => Boolean(x));
  const outcomes = await dealOutcomes(ctx, dealIds);
  const groups = new Map<string, { label: string; rows: Row[] }>();
  for (const r of rows) {
    const g = groupOf(r, filter.group);
    const entry = groups.get(g.key) ?? { label: g.label, rows: [] };
    entry.rows.push(r);
    groups.set(g.key, entry);
  }
  const out = [...groups.entries()].map(([key, g]) => ({ key, label: g.label, ...count(g.rows, outcomes) })).sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));
  return { from, to, group: filter.group, rows: out, total: count(rows, outcomes), wonKnown: outcomes !== null };
}

/** The report as CSV rows (header first). */
export function reportCsvRows(report: FunnelReport): unknown[][] {
  const head = [GROUP_LABELS[report.group].toLowerCase(), "leads", "contacted", "qualified", "converted", "won", "disqualified", "contacted_pct", "qualified_pct", "converted_pct", "won_pct", "median_speed_to_lead_min", "won_value"];
  const line = (label: string, c: FunnelCounts) => {
    const r = stepRates(c);
    return [
      label,
      c.leads,
      c.contacted,
      c.qualified,
      c.converted,
      report.wonKnown ? c.won : "",
      c.disqualified,
      r.contacted ?? "",
      r.qualified ?? "",
      r.converted ?? "",
      report.wonKnown ? (r.won ?? "") : "",
      c.medianMinutes === null ? "" : Math.round(c.medianMinutes),
      report.wonKnown ? (c.wonValueCents / 100).toFixed(2) : "",
    ];
  };
  return [head, ...report.rows.map((r) => line(r.label, r)), line("Total", report.total)];
}

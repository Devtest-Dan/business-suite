import type { ModulePageProps } from "@/lib/modules/contract";
import { P } from "../data";
import { formatMinutes } from "../logic";
import { funnelReport, GROUP_LABELS, stepRates, type FunnelCounts } from "../report";
import { reportFilter } from "../schemas";
import { SubNav } from "./parts";

const money = (cents: number) => (cents / 100).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number | null) => (n === null ? "—" : `${n}%`);

/** The funnel as bars: each step's width is its share of the leads that came in. */
function FunnelChart({ total, wonKnown }: { total: FunnelCounts; wonKnown: boolean }) {
  const rates = stepRates(total);
  const steps = [
    { label: "Leads", n: total.leads, rate: null as number | null },
    { label: "Contacted", n: total.contacted, rate: rates.contacted },
    { label: "Qualified", n: total.qualified, rate: rates.qualified },
    { label: "Converted", n: total.converted, rate: rates.converted },
    ...(wonKnown ? [{ label: "Won", n: total.won, rate: rates.won }] : []),
  ];
  const most = Math.max(1, total.leads);
  return (
    <figure className="space-y-2" aria-label="The funnel">
      <ul className="space-y-2" data-testid="funnel-chart">
        {steps.map((s) => (
          <li key={s.label} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 text-sm">
            <span className="font-medium">{s.label}</span>
            <span className="h-6 rounded-md bg-surface-2" aria-hidden>
              <span className="block h-6 rounded-md bg-accent" style={{ width: `${s.n ? Math.max(2, (s.n / most) * 100) : 0}%` }} />
            </span>
            <span className="tabular-nums">
              {s.n}
              {s.rate !== null ? <span className="text-subtle"> · {pct(s.rate)} of the step before</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export async function ReportPage({ ctx, searchParams, basePath }: ModulePageProps) {
  const filter = reportFilter.parse(searchParams);
  const report = await funnelReport(ctx, filter);
  const q = new URLSearchParams({ from: report.from, to: report.to, group: report.group }).toString();
  return (
    <div className="space-y-5">
      <header>
        <h1 className="h1">Funnel report</h1>
        <p className="muted">Leads that came in between the two dates, and how far each one got. A lead counts at every step it reached.</p>
      </header>
      <SubNav basePath={basePath} current="report" canManage={ctx.can(P.manage)} />
      <form method="get" action={`${basePath}/report`} className="card flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">From</span>
          <input type="date" name="from" defaultValue={report.from} className="input" />
        </label>
        <label className="block">
          <span className="label">To</span>
          <input type="date" name="to" defaultValue={report.to} className="input" />
        </label>
        <label className="block">
          <span className="label">Per</span>
          <select name="group" defaultValue={report.group} className="input">
            {Object.entries(GROUP_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn">
          Show
        </button>
        <a className="btn" href={`/api/m/funnel/report-csv?${q}`} download>
          Export CSV
        </a>
      </form>
      {!report.wonKnown ? <p className="notice notice-warn text-sm">Won deals come from Customers, which is switched off or which your role cannot open, so “won” is not shown.</p> : null}
      <section className="card space-y-4">
        <div className="flex flex-wrap gap-6 text-sm" data-testid="report-totals">
          <p>
            <span className="block text-subtle">Leads</span>
            <span className="text-2xl font-semibold tabular-nums">{report.total.leads}</span>
          </p>
          <p>
            <span className="block text-subtle">Median speed to lead</span>
            <span className="text-2xl font-semibold">{report.total.medianMinutes === null ? "—" : formatMinutes(report.total.medianMinutes)}</span>
          </p>
          {report.wonKnown ? (
            <p>
              <span className="block text-subtle">Won value</span>
              <span className="text-2xl font-semibold tabular-nums">{money(report.total.wonValueCents)}</span>
            </p>
          ) : null}
          <p>
            <span className="block text-subtle">Disqualified</span>
            <span className="text-2xl font-semibold tabular-nums">{report.total.disqualified}</span>
          </p>
        </div>
        {report.total.leads ? <FunnelChart total={report.total} wonKnown={report.wonKnown} /> : <p className="muted">No leads came in between these dates.</p>}
      </section>
      {report.rows.length ? (
        <div className="card overflow-x-auto p-0 sm:p-0">
          <table className="table" data-testid="report-table">
            <thead>
              <tr>
                <th>{GROUP_LABELS[report.group]}</th>
                <th className="text-right">Leads</th>
                <th className="text-right">Contacted</th>
                <th className="text-right">Qualified</th>
                <th className="text-right">Converted</th>
                {report.wonKnown ? <th className="text-right">Won</th> : null}
                <th className="hidden text-right md:table-cell">Median speed</th>
                {report.wonKnown ? <th className="hidden text-right md:table-cell">Won value</th> : null}
              </tr>
            </thead>
            <tbody>
              {[...report.rows, { key: "total", label: "Total", ...report.total }].map((r) => {
                const rate = stepRates(r);
                return (
                  <tr key={r.key} className={r.key === "total" ? "font-semibold" : undefined}>
                    <td>{r.label}</td>
                    <td className="text-right tabular-nums">{r.leads}</td>
                    <td className="text-right tabular-nums">
                      {r.contacted} <span className="text-xs text-subtle">{pct(rate.contacted)}</span>
                    </td>
                    <td className="text-right tabular-nums">
                      {r.qualified} <span className="text-xs text-subtle">{pct(rate.qualified)}</span>
                    </td>
                    <td className="text-right tabular-nums">
                      {r.converted} <span className="text-xs text-subtle">{pct(rate.converted)}</span>
                    </td>
                    {report.wonKnown ? (
                      <td className="text-right tabular-nums">
                        {r.won} <span className="text-xs text-subtle">{pct(rate.won)}</span>
                      </td>
                    ) : null}
                    <td className="hidden text-right md:table-cell">{r.medianMinutes === null ? "—" : formatMinutes(r.medianMinutes)}</td>
                    {report.wonKnown ? <td className="hidden text-right tabular-nums md:table-cell">{money(r.wonValueCents)}</td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="hint">The percentage beside each number is its share of the step before it. Speed to lead leaves out imported leads.</p>
    </div>
  );
}

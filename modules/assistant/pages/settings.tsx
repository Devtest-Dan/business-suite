import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { saveLimitsAction } from "../actions";
import { assistantSettingsRow } from "../facts";
import { P } from "../ids";
import { monthUsage, readLimits, shareUsed, usageByPerson } from "../usage";

const fmt = (n: number) => n.toLocaleString("en");

export async function SettingsPage({ ctx, basePath }: ModulePageProps) {
  const [limits, settings, people] = await Promise.all([readLimits(), assistantSettingsRow(ctx.db), usageByPerson()]);
  const usage = await monthUsage(undefined, limits);
  const share = shareUsed(limits, usage);

  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="h1">Assistant settings</h1>
        <p className="muted">
          Limits for the assistant&apos;s use of the AI provider, and how facts are stored. The provider itself is chosen in{" "}
          <Link className="link" href="/settings/ai">
            Settings → AI
          </Link>
          .
        </p>
      </header>

      <section className="card space-y-3" aria-labelledby="usage" data-testid="usage">
        <h2 id="usage" className="h2">
          This month ({usage.month}, UTC)
        </h2>
        <p className="text-sm">
          {fmt(usage.calls)} model call{usage.calls === 1 ? "" : "s"}: {fmt(usage.inputTokens)} tokens in, {fmt(usage.outputTokens)} tokens out
          {usage.spend !== null ? `, about ${usage.spend.toFixed(2)} ${limits.currency} at your prices` : ""}.
          {share !== null ? ` That is ${Math.floor(share * 100)}% of the tighter limit.` : " No limit is set."}
        </p>
        <p className="hint">Counts are what the provider reported for each call. Spend is an estimate from your prices below; your provider&apos;s bill is the real figure.</p>
        {people.length ? (
          <table className="table text-sm">
            <thead>
              <tr>
                <th>Person</th>
                <th className="text-right">Calls</th>
                <th className="text-right">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId}>
                  <td>{p.name}</td>
                  <td className="text-right">{fmt(p.calls)}</td>
                  <td className="text-right">{fmt(p.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <ActionForm action={saveLimitsAction} submit="Save" className="card space-y-4">
        <div>
          <h2 className="h2">Monthly limits</h2>
          <p className="muted text-sm">When a limit is reached the assistant pauses for everyone until the 1st of next month (UTC), and you get one notice. Leave a box empty for no limit.</p>
        </div>
        <label className="block">
          <span className="label">Token limit per month (input + output, whole team)</span>
          <input name="monthlyTokenCap" inputMode="numeric" defaultValue={limits.monthlyTokenCap ?? ""} className="input" placeholder="No limit" />
        </label>
        <fieldset className="space-y-3">
          <legend className="label">Spend limit (needs your provider&apos;s prices)</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Price per million input tokens</span>
              <input name="pricePerMillionIn" inputMode="decimal" defaultValue={limits.pricePerMillionIn ?? ""} className="input" placeholder="From the price page" />
            </label>
            <label className="block">
              <span className="label">Price per million output tokens</span>
              <input name="pricePerMillionOut" inputMode="decimal" defaultValue={limits.pricePerMillionOut ?? ""} className="input" placeholder="From the price page" />
            </label>
            <label className="block">
              <span className="label">Spend limit per month</span>
              <input name="monthlySpendCap" inputMode="decimal" defaultValue={limits.monthlySpendCap ?? ""} className="input" placeholder="No limit" />
            </label>
            <label className="block">
              <span className="label">Currency</span>
              <input name="currency" required maxLength={3} defaultValue={limits.currency} className="input uppercase" />
            </label>
          </div>
          <p className="hint">Copy the prices from your AI provider&apos;s own price page; the suite does not assume any. A local model costs nothing per token: use a token limit, or none.</p>
        </fieldset>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="redactFacts" defaultChecked={settings.redactFacts} className="mt-0.5 size-4" />
          <span>
            Replace personal details in facts (names, emails, phone numbers, addresses) with placeholders before they are stored. Recommended when interns&apos; coding agents
            read the brain. Secrets and card numbers are always removed.
          </span>
        </label>
      </ActionForm>

      {ctx.can(P.agents) ? (
        <p className="text-sm">
          <Link className="link" href={`${basePath}/agents`}>
            Coding agents: give an intern&apos;s agent access to the brain →
          </Link>
        </p>
      ) : null}
    </div>
  );
}

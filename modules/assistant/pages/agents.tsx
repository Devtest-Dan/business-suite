import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { formatDate, formatDateTime } from "@/lib/format";
import type { ModulePageProps } from "@/lib/modules/contract";
import { createAgentAction, revokeAgentAction } from "../actions";
import { listAgents, MAX_ACTIVE_AGENTS, mcpUrl } from "../agents";
import { brain } from "../brain";
import { AgentTokenForm } from "./agent-token-form";

export async function AgentsPage({ ctx, basePath }: ModulePageProps) {
  const b = brain();
  const agents = await listAgents();
  const now = new Date();
  const tz = ctx.business.timezone;
  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <Link href={`${basePath}/facts`} className="link text-sm">
          ← What the assistant knows
        </Link>
        <h1 className="h1">Coding agents</h1>
        <p className="muted">
          An intern building your apps with a coding agent (Claude Code, Codex, Hermes, OpenClaw) can connect it to the business brain, so it knows how the business works
          without asking you again. Each access is a token for one agent, for at most 90 days, and you can revoke it at any time. At most {MAX_ACTIVE_AGENTS} can be live at
          once.
        </p>
      </header>

      {!b ? (
        <p className="notice notice-warn">
          The brain is off on this server, so there is nothing for an agent to connect to. docs/apps/assistant.md, “Switch the brain on”, says how (one line on the server).
        </p>
      ) : (
        <AgentTokenForm action={createAgentAction} />
      )}

      <section className="space-y-3" aria-labelledby="access-list">
        <h2 id="access-list" className="h2">
          Access tokens
        </h2>
        <p className="text-sm text-subtle">Address agents use: {mcpUrl()}</p>
        {agents.length === 0 ? (
          <p className="card muted">No coding agent has access yet.</p>
        ) : (
          <ul className="card divide-y divide-line p-0 sm:p-0" data-testid="agent-list">
            {agents.map((a) => {
              const live = !a.revokedAt && a.expiresAt > now;
              return (
                <li key={a.clientId} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium">{a.label}</p>
                    <p className="text-xs text-subtle">
                      Created by {a.createdByName}, {formatDate(a.createdAt, tz)} ·{" "}
                      {a.revokedAt ? `Revoked ${formatDate(a.revokedAt, tz)}` : a.expiresAt <= now ? `Expired ${formatDate(a.expiresAt, tz)}` : `Expires ${formatDate(a.expiresAt, tz)}`}
                      {a.lastUsedAt ? ` · Last used ${formatDateTime(a.lastUsedAt, tz)}` : " · Not used yet"}
                    </p>
                  </div>
                  {live ? (
                    <ActionForm action={revokeAgentAction} submit="Revoke" submitClassName="btn btn-danger" className="flex items-center gap-2">
                      <input type="hidden" name="clientId" value={a.clientId} />
                    </ActionForm>
                  ) : (
                    <span className="badge">{a.revokedAt ? "Revoked" : "Expired"}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

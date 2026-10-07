import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";
import { UserError } from "@/lib/errors";
import type { Viewer } from "@/lib/modules/contract";
import { brain, BrainError } from "./brain";
import { agentOwnsFacts, recordAgentFacts } from "./facts";
import { MODULE_ID } from "./ids";
import { refusalBody, rememberedFacts, replaceRequests } from "./mcp";
import { assistantAgents } from "./schema";

/**
 * MCP access to the brain for an intern's coding agent (Claude Code, Codex,
 * Hermes, OpenClaw). The token is a GBrain access token for a client limited
 * to memory verbs (no forget, no admin); the suite keeps only its hash and
 * checks every request at /api/m/assistant/mcp before passing it on:
 * - an unknown, revoked or expired token gets 401 here;
 * - a `remember` that would replace a fact is refused unless every fact it
 *   replaces was written by this same token (the AHL brain host's replace
 *   guard): an agent adds notes, it never rewrites the business's facts;
 * - facts the agent saves are recorded here, so the owner sees and can
 *   withdraw them on "What the assistant knows".
 */

/** Most live tokens at once: enough for a few interns and their machines. */
export const MAX_ACTIVE_AGENTS = 10;

export type AgentRow = typeof assistantAgents.$inferSelect;

export function mcpUrl(): string {
  return `${env().publicUrl}/api/m/${MODULE_ID}/mcp`;
}

export async function listAgents(): Promise<AgentRow[]> {
  return db().select().from(assistantAgents).orderBy(desc(assistantAgents.createdAt)).limit(100);
}

function activeWhere(now = new Date()) {
  return and(isNull(assistantAgents.revokedAt), gt(assistantAgents.expiresAt, now));
}

export async function createAgentAccess(viewer: Viewer, input: { label: string; days: number }): Promise<{ token: string; url: string; expiresAt: Date; clientId: string }> {
  const b = brain();
  if (!b) throw new UserError("The brain is off, so there is nothing for a coding agent to connect to. Switch the brain on first (docs/apps/assistant.md).");
  const active = await db().select({ id: assistantAgents.clientId }).from(assistantAgents).where(activeWhere());
  if (active.length >= MAX_ACTIVE_AGENTS) throw new UserError(`There are already ${MAX_ACTIVE_AGENTS} live access tokens. Revoke one you no longer use, then create this one.`);
  const grant = await b.grantAgent(`agent-${randomBytes(6).toString("hex")}`, input.days * 86_400);
  const expiresAt = new Date(grant.expiresAt);
  await db().insert(assistantAgents).values({
    clientId: grant.clientId,
    label: input.label,
    tokenHash: sha256(grant.token),
    createdBy: viewer.id,
    createdByName: viewer.name,
    expiresAt,
  });
  await audit({
    actor: userActor(viewer),
    action: "assistant.agent_access_created",
    module: MODULE_ID,
    target: { type: "agent_access", id: grant.clientId },
    summary: `${viewer.name} created brain access “${input.label}” for a coding agent (${input.days} days).`,
  });
  return { token: grant.token, url: mcpUrl(), expiresAt, clientId: grant.clientId };
}

export async function revokeAgentAccess(viewer: Viewer, clientId: string): Promise<void> {
  const [row] = await db().select().from(assistantAgents).where(eq(assistantAgents.clientId, clientId));
  if (!row) throw new UserError("That access is gone. Reload the page.");
  if (row.revokedAt) return;
  const b = brain();
  if (b) {
    try {
      await b.revokeAgent(clientId);
    } catch (error) {
      // Already unknown to the brain (e.g. its storage was recreated): revoking here is enough.
      if (!(error instanceof BrainError) || !/does not know/.test(error.message)) throw error;
    }
  }
  // With the brain off, the suite's check alone stops the token (every request goes through it).
  await db().update(assistantAgents).set({ revokedAt: new Date() }).where(eq(assistantAgents.clientId, clientId));
  await audit({
    actor: userActor(viewer),
    action: "assistant.agent_access_revoked",
    module: MODULE_ID,
    target: { type: "agent_access", id: clientId },
    summary: `${viewer.name} revoked brain access “${row.label}”.`,
  });
}

const unauthorized = (why: string) =>
  Response.json({ error: why }, { status: 401, headers: { "www-authenticate": 'Bearer realm="business-brain"' } });

/** The handler behind /api/m/assistant/mcp. */
export async function handleMcp(request: Request): Promise<Response> {
  const b = brain();
  if (!b) return Response.json({ error: "The business brain is switched off on this server." }, { status: 503 });
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return unauthorized("Send the access token as: Authorization: Bearer <token>.");
  const [agent] = await db()
    .select()
    .from(assistantAgents)
    .where(and(eq(assistantAgents.tokenHash, sha256(m[1])), activeWhere()));
  if (!agent) return unauthorized("This access token is not valid any more (revoked, expired or mistyped). Ask the owner for a new one.");
  await db().update(assistantAgents).set({ lastUsedAt: new Date() }).where(eq(assistantAgents.clientId, agent.clientId));

  if (request.method !== "POST") return b.forwardMcp(request.method, request.headers, undefined);
  const body = await request.text();
  if (body.length > 256_000) return Response.json({ error: "That request is too large for the brain (256 KB at most)." }, { status: 413 });

  const replacing = replaceRequests(body);
  if (replacing.length) {
    const allowed = await Promise.all(replacing.map((r) => agentOwnsFacts(agent.clientId, r.targets)));
    const blocked = replacing.filter((_, i) => !allowed[i]);
    if (blocked.length) {
      return new Response(
        refusalBody(
          body,
          blocked.map((b) => b.rpcId),
          "Refused: an agent cannot change or replace the business's facts. Save a new note instead; only a note this same access token wrote can be replaced.",
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
  }

  const res = await b.forwardMcp("POST", request.headers, body);
  if (res.status !== 200 || !/"remember"/.test(body)) return res;
  const text = await res.text();
  const saved = rememberedFacts(body, res.headers.get("content-type") ?? "", text);
  if (saved.length) await recordAgentFacts(agent.clientId, agent.label, saved).catch((error) => console.error("Could not record an agent's facts:", error));
  return new Response(text, { status: res.status, headers: res.headers });
}

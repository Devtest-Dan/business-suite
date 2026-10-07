import "server-only";
import { eq } from "drizzle-orm";
import { seal, unseal } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { UserError } from "@/lib/errors";
import { McpCallError, callTool } from "./mcp";
import { assistantBrainClient } from "./schema";

/**
 * The business brain: one GBrain (github.com/garrytan/gbrain, MIT) for the
 * whole business, run as the optional `brain` service in docker compose
 * (deploy/brain/). Keyword-only: it is never given an embedding or chat key.
 *
 * The suite talks to it in two ways, as the AHL brain host does:
 * - memory verbs (`remember`, `recall`, `forget`) over MCP, as the suite's own
 *   scoped client (created once through GBrain's owner API, secret sealed in
 *   assistant_brain_client);
 * - client administration (mint and revoke coding-agent tokens) through the
 *   owner API, signed in with BRAIN_ADMIN_TOKEN, which never leaves the server.
 *
 * Off when BRAIN_URL is not set: facts then live only in the suite's database.
 */

export class BrainError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = "BrainError";
  }
}

export interface BrainFact {
  gbrainId: string;
  text: string;
  kind: string;
  provenance: string | null;
  createdAt: string;
  /** Withdrawn (forget) or replaced by a newer wording. */
  expired: boolean;
  supersededBy: string | null;
}

export interface AgentGrant {
  clientId: string;
  token: string;
  expiresAt: string;
}

/** What the module needs from the brain. GbrainHttp is the real one; tests use a fake. */
export interface Brain {
  health(): Promise<{ ok: boolean; version: string | null; detail?: string }>;
  remember(input: { text: string; kind: string; provenance: string; replaces?: string }): Promise<{ gbrainId: string }>;
  /** Newest first. `grep` is a case-insensitive substring of the fact text. */
  recall(opts: { grep?: string; limit: number; includeExpired: boolean }): Promise<BrainFact[]>;
  forget(gbrainId: string, reason: string): Promise<void>;
  grantAgent(name: string, ttlSeconds: number): Promise<AgentGrant>;
  revokeAgent(clientId: string): Promise<void>;
  /** Sends an agent's MCP request on to the brain's /mcp, unchanged. */
  forwardMcp(method: string, headers: Headers, body: string | undefined): Promise<Response>;
}

/** Operations a coding agent's token may call: memory verbs only. No forget, no page writes, no admin. */
export const AGENT_OPERATIONS = ["recall", "remember", "entity", "context_pack", "delta", "synthesize", "whoami"] as const;
/** Operations the suite's own client needs. */
const SUITE_OPERATIONS = ["recall", "remember", "forget", "whoami"] as const;
/** GBrain caps an access token's life at 90 days. */
export const AGENT_DAYS = [7, 30, 90] as const;
export const GBRAIN_KINDS = ["fact", "preference", "commitment", "event", "belief"] as const;

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "proxy-connection", "te", "trailer", "cookie"];

/**
 * BRAIN_URL: where the suite reaches the brain (http://brain:7410 in compose).
 * BRAIN_PUBLIC_URL: the address the brain was started with (`--public-url`);
 * GBrain requires HTTPS or loopback there and checks a new client's MCP URL
 * against it, so in compose it is http://127.0.0.1:7410 although the suite
 * connects by service name. Defaults to BRAIN_URL.
 */
export function brainConfig(): { url: string; publicUrl: string; adminToken: string } | null {
  const url = process.env.BRAIN_URL?.trim().replace(/\/+$/, "");
  if (!url) return null;
  const publicUrl = process.env.BRAIN_PUBLIC_URL?.trim().replace(/\/+$/, "") || url;
  return { url, publicUrl, adminToken: process.env.BRAIN_ADMIN_TOKEN?.trim() ?? "" };
}

const unreachable = () => new BrainError("The brain did not answer. Nothing was changed there; try again in a minute. If it keeps happening, the owner can check it with `suite.sh logs brain`.");

export class GbrainHttp implements Brain {
  private token: { value: string; exp: number } | null = null;
  private cookie: { value: string; exp: number } | null = null;

  constructor(
    private readonly url: string,
    private readonly adminToken: string,
    private readonly publicUrl: string = url,
  ) {}

  async health(): Promise<{ ok: boolean; version: string | null; detail?: string }> {
    try {
      const r = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(4000) });
      const j = (await r.json().catch(() => ({}))) as { version?: string; status?: string };
      return { ok: r.ok, version: j.version ?? null, detail: r.ok ? undefined : `answered ${r.status}` };
    } catch (e) {
      return { ok: false, version: null, detail: e instanceof Error ? e.message : "unreachable" };
    }
  }

  // ── owner API (client administration) ──────────────────────────────────────

  private async adminCookie(force = false): Promise<string> {
    if (!force && this.cookie && this.cookie.exp > Date.now()) return this.cookie.value;
    if (!this.adminToken) throw new BrainError("BRAIN_ADMIN_TOKEN is not set, so the suite cannot manage the brain. Add it to the server's .env (docs/apps/assistant.md) and restart.");
    let r: Response;
    try {
      r = await fetch(`${this.url}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: this.url },
        body: JSON.stringify({ token: this.adminToken }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw unreachable();
    }
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("gbrain_admin="));
    if (!r.ok || !cookie) throw new BrainError("The brain refused the suite's owner token. BRAIN_ADMIN_TOKEN in the .env must match the one the brain started with; restart both after changing it.");
    this.cookie = { value: cookie, exp: Date.now() + 10 * 60_000 };
    return cookie;
  }

  private async adminPost(path: string, body: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cookie = await this.adminCookie(attempt > 0);
      let r: Response;
      try {
        r = await fetch(`${this.url}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin: this.url },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw unreachable();
      }
      const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.status === 401 && attempt === 0) continue;
      if (r.status === 404) throw new BrainError("The brain does not know this access any more. It may have been removed already.");
      if (!r.ok) throw new BrainError(`The brain refused the request (${r.status}${json.code ? `, ${String(json.code)}` : ""}). Try again; if it keeps failing, check \`suite.sh logs brain\`.`);
      return json;
    }
    throw new BrainError("The brain refused the suite's owner token. Restart the brain and the app.");
  }

  private async provision(name: string, operations: readonly string[], ttlSeconds: number) {
    const res = await this.adminPost("/admin/api/grants", {
      name,
      harness: "generic",
      url: `${this.publicUrl}/mcp`,
      profile: "memory-writer",
      sourceId: "default",
      sharedSkills: "memory-only",
      patch: { allowedOperations: [...operations], tokenTtlSeconds: ttlSeconds },
    });
    const c = res.credentials as { client_id?: string; client_secret?: string; access_token?: string; expires_at?: number } | undefined;
    if (!c?.client_id || !c.client_secret || !c.access_token || !c.expires_at) throw new BrainError("The brain did not return the new access. Try again.");
    return { clientId: c.client_id, secret: c.client_secret, token: c.access_token, expiresAt: c.expires_at };
  }

  async grantAgent(name: string, ttlSeconds: number): Promise<AgentGrant> {
    const c = await this.provision(name, AGENT_OPERATIONS, ttlSeconds);
    // The secret is not kept: an agent that needs more time gets a new token.
    return { clientId: c.clientId, token: c.token, expiresAt: new Date(c.expiresAt * 1000).toISOString() };
  }

  async revokeAgent(clientId: string): Promise<void> {
    const path = `/admin/api/clients/${encodeURIComponent(clientId)}/lifecycle`;
    const preview = await this.adminPost(path, { action: "revoke", dryRun: true });
    const revision = (preview.before as { revision?: unknown } | undefined)?.revision;
    if (typeof revision !== "number") throw new BrainError("The brain did not say which version of this access it holds. Try again.");
    await this.adminPost(path, { action: "revoke", dryRun: false, yes: true, expectedRevision: revision });
  }

  // ── the suite's own client (memory verbs) ──────────────────────────────────

  /** Creates the suite's own client on the brain and keeps its secret (sealed). Returns a fresh token. */
  private async provisionSuiteClient(): Promise<string> {
    const c = await this.provision("business-suite", SUITE_OPERATIONS, 3600);
    const secret = JSON.stringify(seal(c.secret));
    await db()
      .insert(assistantBrainClient)
      .values({ id: 1, clientId: c.clientId, secret })
      .onConflictDoUpdate({ target: assistantBrainClient.id, set: { clientId: c.clientId, secret, createdAt: new Date() } });
    this.token = { value: c.token, exp: c.expiresAt * 1000 };
    return c.token;
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.exp - 60_000 > Date.now()) return this.token.value;
    for (let attempt = 0; attempt < 2; attempt++) {
      const [row] = await db().select().from(assistantBrainClient).where(eq(assistantBrainClient.id, 1));
      if (!row) return this.provisionSuiteClient();
      const client = { clientId: row.clientId, secret: unseal(JSON.parse(row.secret)) };
      let r: Response;
      try {
        r = await fetch(`${this.url}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: client.clientId, client_secret: client.secret }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw unreachable();
      }
      const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
      if (r.ok && j.access_token) {
        this.token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
        return j.access_token;
      }
      // The brain does not know the stored client (e.g. its volume was recreated): make a new one once.
      if (attempt === 0 && (r.status === 400 || r.status === 401)) {
        await db().delete(assistantBrainClient).where(eq(assistantBrainClient.id, 1));
        this.token = null;
        continue;
      }
      break;
    }
    throw new BrainError("The brain refused the suite's own access. Restart the app; if it persists, check `suite.sh logs brain`.");
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      try {
        return await callTool(`${this.url}/mcp`, token, name, args);
      } catch (e) {
        if (e instanceof McpCallError && e.kind === "auth" && attempt === 0) continue;
        if (e instanceof McpCallError && e.kind === "tool") throw e;
        throw unreachable();
      }
    }
    throw unreachable();
  }

  async remember(input: { text: string; kind: string; provenance: string; replaces?: string }): Promise<{ gbrainId: string }> {
    const args: Record<string, unknown> = {
      fact: input.text,
      provenance: input.provenance,
      kind: (GBRAIN_KINDS as readonly string[]).includes(input.kind) ? input.kind : "fact",
      visibility: "world",
      infer_entity: false,
      request_id: crypto.randomUUID(),
    };
    if (input.replaces) args.replaces = input.replaces;
    let r: Record<string, unknown>;
    try {
      r = await this.tool("remember", args);
    } catch (e) {
      if (e instanceof McpCallError && e.kind === "tool") {
        if (input.replaces && /\b(replaces_|target_)/.test(`${e.code} ${e.message}`)) throw new BrainReplaceRefused();
        throw new BrainError(`The brain refused this fact (${e.code}). Check that it is plain prose without secrets.`);
      }
      throw e;
    }
    if (r.id === undefined || r.id === null) throw new BrainError("The brain did not confirm the write. Try again.");
    return { gbrainId: String(r.id) };
  }

  async recall(opts: { grep?: string; limit: number; includeExpired: boolean }): Promise<BrainFact[]> {
    const args: Record<string, unknown> = { limit: opts.limit, include_expired: opts.includeExpired };
    if (opts.grep) args.grep = opts.grep;
    let r: Record<string, unknown>;
    try {
      r = await this.tool("recall", args);
    } catch (e) {
      if (e instanceof McpCallError && e.kind === "tool") throw new BrainError(`The brain could not search (${e.code}). Try again in a minute.`);
      throw e;
    }
    const facts = Array.isArray(r.facts) ? (r.facts as Record<string, unknown>[]) : [];
    return facts.map((f) => ({
      gbrainId: String(f.fact_id ?? f.id),
      text: String(f.fact ?? ""),
      kind: String(f.kind ?? "fact"),
      provenance: (f.provenance ?? f.source ?? null) as string | null,
      createdAt: toIso(f.created_at ?? f.valid_from),
      expired: f.expired_at != null || (f.valid_until != null && Date.parse(String(f.valid_until)) <= Date.now()),
      supersededBy: f.superseded_by != null ? String(f.superseded_by) : null,
    }));
  }

  async forget(gbrainId: string, reason: string): Promise<void> {
    try {
      await this.tool("forget", { id: gbrainId, reason, request_id: crypto.randomUUID() });
    } catch (e) {
      if (e instanceof McpCallError && e.kind === "tool") {
        if (e.code === "not_found") return; // already gone from the brain: nothing to withdraw there
        throw new BrainError(`The brain could not withdraw this fact (${e.code}). Try again in a minute.`);
      }
      throw e;
    }
  }

  async forwardMcp(method: string, headers: Headers, body: string | undefined): Promise<Response> {
    const out = new Headers();
    headers.forEach((v, k) => {
      if (!HOP_BY_HOP.includes(k.toLowerCase())) out.set(k, v);
    });
    let upstream: Response;
    try {
      upstream = await fetch(`${this.url}/mcp`, { method, headers: out, body, redirect: "manual", signal: AbortSignal.timeout(120_000) });
    } catch {
      return Response.json({ error: "The business brain did not answer. Try again in a minute." }, { status: 503 });
    }
    const back = new Headers();
    upstream.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.includes(k.toLowerCase()) && k.toLowerCase() !== "content-encoding" && k.toLowerCase() !== "set-cookie") back.set(k, v);
    });
    return new Response(upstream.body, { status: upstream.status, headers: back });
  }
}

/** GBrain will not chain this replacement; the caller withdraws and writes anew instead. */
export class BrainReplaceRefused extends BrainError {
  constructor() {
    super("The brain refused to replace this fact.");
    this.name = "BrainReplaceRefused";
  }
}

function toIso(v: unknown): string {
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(0).toISOString();
}

const globalForBrain = globalThis as unknown as { suiteBrain?: { key: string; brain: Brain }; suiteBrainOverride?: Brain | null };

/** The brain, or null when it is switched off (BRAIN_URL not set). */
export function brain(): Brain | null {
  if (globalForBrain.suiteBrainOverride !== undefined) return globalForBrain.suiteBrainOverride;
  const cfg = brainConfig();
  if (!cfg) return null;
  const key = `${cfg.url}|${cfg.publicUrl}|${cfg.adminToken}`;
  if (globalForBrain.suiteBrain?.key !== key) globalForBrain.suiteBrain = { key, brain: new GbrainHttp(cfg.url, cfg.adminToken, cfg.publicUrl) };
  return globalForBrain.suiteBrain.brain;
}

/** Tests only: put a fake brain in place (null = off; undefined = back to the environment). */
export function setBrainForTests(b: Brain | null | undefined): void {
  globalForBrain.suiteBrainOverride = b;
}

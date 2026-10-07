import { createServer, type Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedAi } from "@/lib/ai/client";
import { approve, propose } from "@/lib/approvals/ledger";
import { moduleContext } from "@/lib/auth/session";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { approvalItems } from "@/lib/db/schema";
import { handleMcp } from "@/modules/assistant/agents";
import { BrainReplaceRefused, setBrainForTests, type AgentGrant, type Brain, type BrainFact } from "@/modules/assistant/brain";
import { assistantTurn } from "@/modules/assistant/chat";
import { addFact, adoptFromBrain, cleanFactText, correctFact, getFact, listFacts, pushToBrain, recallFacts, syncPending, withdrawFact } from "@/modules/assistant/facts";
import { refusalBody, rememberedFacts, replaceRequests } from "@/modules/assistant/mcp";
import { assistantAgents, assistantFacts, assistantSettings, assistantUsage } from "@/modules/assistant/schema";
import { ahlMemoryExport } from "@/modules/assistant/schemas";
import { capReached, monthUsage, recordUsage, saveLimits, shareUsed, spendFor } from "@/modules/assistant/usage";
import { makeUser, resetDb } from "./helpers";

/** An in-memory GBrain with the same behaviour the module relies on (the real one runs in EVIDENCE.md). */
class FakeBrain implements Brain {
  facts: (BrainFact & { provenance: string | null })[] = [];
  calls: string[] = [];
  agents = new Map<string, AgentGrant & { revoked: boolean }>();
  refuseReplace = false;
  down = false;
  forwarded: { method: string; body?: string }[] = [];
  private next = 1;

  async health() {
    return { ok: !this.down, version: "0.60.96.0" };
  }
  private check() {
    if (this.down) throw new Error("brain down");
  }
  async remember(input: { text: string; kind: string; provenance: string; replaces?: string }) {
    this.check();
    this.calls.push(`remember${input.replaces ? ` replaces ${input.replaces}` : ""}`);
    if (input.replaces && this.refuseReplace) throw new BrainReplaceRefused();
    // Like GBrain without embeddings: an exact repeat answers with the existing fact.
    const same = this.facts.find((f) => !f.expired && f.text === input.text);
    if (same && !input.replaces) return { gbrainId: same.gbrainId };
    const id = String(this.next++);
    if (input.replaces) {
      const old = this.facts.find((f) => f.gbrainId === input.replaces);
      if (old) {
        old.expired = true;
        old.supersededBy = id;
      }
    }
    this.facts.unshift({ gbrainId: id, text: input.text, kind: input.kind, provenance: input.provenance, createdAt: new Date().toISOString(), expired: false, supersededBy: null });
    return { gbrainId: id };
  }
  async recall(opts: { grep?: string; limit: number; includeExpired: boolean }) {
    this.check();
    return this.facts
      .filter((f) => (opts.includeExpired || !f.expired) && (!opts.grep || f.text.toLowerCase().includes(opts.grep.toLowerCase())))
      .slice(0, opts.limit);
  }
  async forget(id: string) {
    this.check();
    this.calls.push(`forget ${id}`);
    const f = this.facts.find((x) => x.gbrainId === id);
    if (f) f.expired = true;
  }
  async grantAgent(name: string, ttlSeconds: number) {
    const g = { clientId: `c_${name}`, token: `tok_${name}`, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(), revoked: false };
    this.agents.set(g.clientId, g);
    return g;
  }
  async revokeAgent(clientId: string) {
    const a = this.agents.get(clientId);
    if (a) a.revoked = true;
  }
  /** Echoes a `remember` like GBrain does (JSON-RPC result with the new id as JSON text). */
  async forwardMcp(method: string, _headers: Headers, body: string | undefined) {
    this.forwarded.push({ method, body });
    const msg = JSON.parse(body ?? "{}");
    if (msg.params?.name === "remember") {
      const r = await this.remember({ text: msg.params.arguments.fact, kind: msg.params.arguments.kind ?? "fact", provenance: "agent", replaces: msg.params.arguments.replaces });
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ id: Number(r.gbrainId), status: "inserted" }) }] } })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({ jsonrpc: "2.0", id: msg.id ?? null, result: { content: [{ type: "text", text: "{}" }] } });
  }
}

let fake: FakeBrain;
const business = { name: "Test Bakery" };

beforeEach(async () => {
  await resetDb();
  await db().execute(sql`truncate table assistant_brain_client`);
  fake = new FakeBrain();
  setBrainForTests(fake);
});
afterEach(() => setBrainForTests(undefined));

describe("MCP helpers (pure)", () => {
  it("finds replace requests in single calls, items and JSON-RPC batches", () => {
    const one = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "remember", arguments: { fact: "x", replaces: "12" } } });
    expect(replaceRequests(one)).toEqual([{ rpcId: 7, targets: ["12"] }]);
    const items = JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "remember", arguments: { items: [{ fact: "a" }, { fact: "b", supersedes: 3 }] } } });
    expect(replaceRequests(items)).toEqual([{ rpcId: 8, targets: ["3"] }]);
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remember", arguments: { fact: "c", replace: "9" } } },
    ]);
    expect(replaceRequests(batch)).toEqual([{ rpcId: 2, targets: ["9"] }]);
    expect(replaceRequests("not json")).toEqual([]);
    expect(replaceRequests(JSON.stringify({ method: "tools/call", params: { name: "remember", arguments: { fact: "new" } } }))).toEqual([]);
  });

  it("pairs remembered texts with GBrain's ids (JSON and SSE replies, items)", () => {
    const req = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remember", arguments: { fact: "Deliveries on Tuesdays", kind: "event" } } });
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: '{"id":41,"status":"inserted"}' }, { type: "text", text: "[gbrain notice]" }] } })}\n\n`;
    expect(rememberedFacts(req, "text/event-stream", sse)).toEqual([{ gbrainId: "41", text: "Deliveries on Tuesdays", kind: "event" }]);
    const reqItems = JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "remember", arguments: { items: [{ fact: "A" }, { fact: "B" }] } } });
    const json = JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: JSON.stringify({ items: [{ id: 5 }, { id: 6, status: "failed" }] }) }] } });
    expect(rememberedFacts(reqItems, "application/json", json)).toEqual([{ gbrainId: "5", text: "A", kind: "fact" }]);
    const err = JSON.stringify({ jsonrpc: "2.0", id: 4, result: { isError: true, content: [{ type: "text", text: "no" }] } });
    expect(rememberedFacts(reqItems, "application/json", err)).toEqual([]);
  });

  it("refuses in the shape of the request (single or batch)", () => {
    expect(JSON.parse(refusalBody('{"id":1}', [1], "No"))).toMatchObject({ id: 1, result: { isError: true } });
    expect(JSON.parse(refusalBody("[{}]", [1, 2], "No"))).toHaveLength(2);
  });
});

describe("fact text is cleaned before it is stored", () => {
  it("always removes secrets and card numbers; personal details only when the owner says so", () => {
    const text = "Call Jane Doe on 555-123-4567. Card 4111 1111 1111 1111. api_key=sk-abcdefghijklmnopqrstuvwxyz123456";
    const kept = cleanFactText(text, { redactPersonal: false, businessName: business.name });
    expect(kept.text).toContain("555-123-4567");
    expect(kept.text).not.toContain("4111 1111 1111 1111");
    expect(kept.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(kept.removed).toBeGreaterThanOrEqual(2);
    const redacted = cleanFactText(text, { redactPersonal: true, businessName: business.name });
    expect(redacted.text).not.toContain("555-123-4567");
    expect(redacted.text).toContain("[phone]");
  });
});

describe("limits (pure)", () => {
  const limits = { monthlyTokenCap: 1000, monthlySpendCap: 2, pricePerMillionIn: 1, pricePerMillionOut: 3, currency: "USD" };
  it("works out spend only from the owner's prices", () => {
    expect(spendFor({ pricePerMillionIn: null, pricePerMillionOut: 3 }, 1e6, 1e6)).toBeNull();
    expect(spendFor(limits, 1e6, 1e6)).toBe(4);
  });
  it("says which limit is reached and how much is used", () => {
    expect(capReached(limits, { inputTokens: 400, outputTokens: 500 })).toBeNull();
    expect(capReached(limits, { inputTokens: 600, outputTokens: 500 })).toBe("tokens");
    expect(capReached({ ...limits, monthlyTokenCap: null }, { inputTokens: 1e6, outputTokens: 400_000 })).toBe("spend");
    expect(shareUsed(limits, { inputTokens: 450, outputTokens: 450 })).toBeCloseTo(0.9);
    expect(shareUsed({ ...limits, monthlyTokenCap: null, monthlySpendCap: null }, { inputTokens: 5, outputTokens: 5 })).toBeNull();
  });
});

describe("facts and the brain (real Postgres, fake brain)", () => {
  it("stores a fact, sends it to the brain, corrects it (history kept) and withdraws it", async () => {
    const owner = await makeUser("owner", "Olive Owner");
    const ctx = await moduleContext("assistant", owner);
    const { fact, push } = await addFact(db(), { text: "We open at 9:00 on weekdays.", kind: "fact", source: "person" }, owner, business);
    expect(await push()).toBe(true);
    expect(fake.facts[0].text).toBe("We open at 9:00 on weekdays.");

    await correctFact(ctx, fact.id, "We open at 8:30 on weekdays.");
    const after = await getFact(db(), fact.id);
    expect(after?.fact.text).toBe("We open at 8:30 on weekdays.");
    expect(after?.fact.status).toBe("corrected");
    expect(after?.versions.map((v) => v.text)).toEqual(["We open at 9:00 on weekdays."]);
    expect(fake.calls).toContain("remember replaces 1");
    expect((await fake.recall({ limit: 10, includeExpired: false })).map((f) => f.text)).toEqual(["We open at 8:30 on weekdays."]);

    await withdrawFact(ctx, fact.id, "no longer true");
    expect((await getFact(db(), fact.id))?.fact.status).toBe("withdrawn");
    expect(await fake.recall({ limit: 10, includeExpired: false })).toEqual([]);
    expect((await recallFacts(db(), "open")).facts).toEqual([]);
  });

  it("falls back to withdraw-then-write when GBrain will not chain a replacement", async () => {
    const owner = await makeUser("owner");
    const ctx = await moduleContext("assistant", owner);
    const { fact, push } = await addFact(db(), { text: "Parking is behind the shop.", kind: "fact", source: "person" }, owner, business);
    await push();
    fake.refuseReplace = true;
    await correctFact(ctx, fact.id, "Parking is in the public lot.");
    expect(fake.calls).toEqual(["remember", "remember replaces 1", "forget 1", "remember"]);
    expect((await getFact(db(), fact.id))?.fact.gbrainId).toBe("2");
  });

  it("keeps a brain fact two records share (GBrain answers an exact repeat with the same id)", async () => {
    const owner = await makeUser("owner");
    const ctx = await moduleContext("assistant", owner);
    const a = await addFact(db(), { text: "Keys are in the blue box.", kind: "fact", source: "person" }, owner, business);
    await a.push();
    const b = await addFact(db(), { text: "Keys are in the blue box.", kind: "fact", source: "person" }, owner, business);
    expect(await b.push()).toBe(true);
    expect((await getFact(db(), b.fact.id))?.fact.gbrainId).toBe("1");
    await correctFact(ctx, b.fact.id, "Keys are in the red box.");
    expect(fake.calls.filter((c) => c.includes("replaces"))).toEqual([]);
    await withdrawFact(ctx, b.fact.id, "");
    expect(fake.calls.filter((c) => c === "forget 1")).toEqual([]);
    expect((await fake.recall({ grep: "blue", limit: 5, includeExpired: false })).length).toBe(1);
  });

  it("changes nothing when the brain does not answer, and sends waiting facts later", async () => {
    const owner = await makeUser("owner");
    const ctx = await moduleContext("assistant", owner);
    const { fact, push } = await addFact(db(), { text: "Bread is baked at 5:00.", kind: "fact", source: "person" }, owner, business);
    await push();
    fake.down = true;
    await expect(correctFact(ctx, fact.id, "Bread is baked at 4:30.")).rejects.toThrow();
    expect((await getFact(db(), fact.id))?.fact.text).toBe("Bread is baked at 5:00.");

    const second = await addFact(db(), { text: "Cakes need two days' notice.", kind: "fact", source: "person" }, owner, business);
    expect(await second.push()).toBe(false);
    expect((await getFact(db(), second.fact.id))?.fact.brainError).toBeTruthy();
    fake.down = false;
    expect(await syncPending()).toEqual({ sent: 1, failed: 0 });
    expect((await getFact(db(), second.fact.id))?.fact.gbrainId).toBeTruthy();
  });

  it("adopts facts found in the brain and merges them into recall", async () => {
    await fake.remember({ text: "Written straight into the brain about invoices.", kind: "fact", provenance: "other" });
    expect(await adoptFromBrain()).toBe(1);
    expect(await adoptFromBrain()).toBe(0);
    const [row] = await listFacts(db());
    expect(row.source).toBe("brain");
    const recalled = await recallFacts(db(), "invoices");
    expect(recalled.brain).toBe("on");
    expect(recalled.facts.map((f) => f.text)).toEqual(["Written straight into the brain about invoices."]);
  });

  it("recalls from the suite's database when the brain is off", async () => {
    setBrainForTests(null);
    const owner = await makeUser("owner");
    const { push } = await addFact(db(), { text: "Refunds within 30 days with a receipt.", kind: "fact", source: "person" }, owner, business);
    expect(await push()).toBe(false);
    const r = await recallFacts(db(), "refund");
    expect(r.brain).toBe("off");
    expect(r.facts).toHaveLength(1);
    expect(await pushToBrain(r.facts[0].id)).toBe(false);
  });
});

describe("writes go through approvals", () => {
  it("a remembered fact the AI proposes is written once, even if approved twice", async () => {
    const owner = await makeUser("owner");
    const { approvalId } = await propose({ action: "assistant.remember", items: [{ text: "Staff meeting every Monday at 8:00.", kind: "event" }], source: "ai", requestedBy: owner, keys: ["ai:t1:0"] });
    expect(await db().select().from(assistantFacts)).toHaveLength(0);
    expect((await approve(approvalId!, owner)).appliedNow).toBe(1);
    expect((await approve(approvalId!, owner)).appliedNow).toBe(0);
    const rows = await db().select().from(assistantFacts);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("assistant");
    expect(rows[0].gbrainId).toBeTruthy();
  });

  it("an AHL export becomes ONE approval; re-importing it adds nothing; withdrawn facts stay out", async () => {
    const owner = await makeUser("owner");
    const exported = ahlMemoryExport.parse({
      format: "ahl-business-memory",
      version: 1,
      exportedAt: "2026-10-07T12:00:00.000Z",
      business: { name: "Test Bakery" },
      facts: [
        { id: "f_aaa", text: "Orders over 50 loaves need a deposit.", kind: "fact", source: "interview", status: "active", updatedAt: "2026-10-01T10:00:00Z" },
        { id: "f_bbb", text: "The owner answers email after 18:00.", kind: "preference", source: "owner", status: "corrected", updatedAt: "2026-10-02T10:00:00Z", history: [{ text: "The owner answers email in the evening.", at: "2026-09-30T10:00:00Z", by: "interview" }] },
        { id: "f_ccc", text: "Old fact.", source: "brief", status: "withdrawn", updatedAt: "2026-10-03T10:00:00Z" },
      ],
    });
    const items = exported.facts
      .filter((f) => f.status !== "withdrawn")
      .map((f) => ({ externalId: f.id, text: f.text, kind: f.kind, originalSource: f.source, updatedAt: f.updatedAt, history: f.history }));
    const first = await propose({ action: "assistant.import_fact", items, source: "import", requestedBy: owner, keys: items.map((i) => `ahl:${i.externalId}`) });
    expect(first.accepted).toBe(2);
    await approve(first.approvalId!, owner);
    const facts = await listFacts(db());
    expect(facts).toHaveLength(2);
    const corrected = facts.find((f) => f.text.startsWith("The owner answers"))!;
    expect((await getFact(db(), corrected.id))?.versions.map((v) => v.text)).toEqual(["The owner answers email in the evening."]);
    expect(corrected.sourceDetail).toBe("Added by the owner on AHL");
    const again = await propose({ action: "assistant.import_fact", items, source: "import", requestedBy: owner, keys: items.map((i) => `ahl:${i.externalId}`) });
    expect(again.approvalId).toBeNull();
    expect(again.duplicates).toBe(2);
    expect(await db().select().from(approvalItems).where(eq(approvalItems.action, "assistant.import_fact"))).toHaveLength(2);
  });
});

describe("the coding-agent MCP address", () => {
  async function agent(label = "Claude Code on test") {
    const owner = await makeUser("owner");
    const g = await fake.grantAgent(label.replace(/\W/g, ""), 86400);
    await db().insert(assistantAgents).values({ clientId: g.clientId, label, tokenHash: sha256(g.token), createdBy: owner.id, createdByName: owner.name, expiresAt: new Date(g.expiresAt) });
    return { owner, token: g.token, clientId: g.clientId };
  }
  const rpc = (args: Record<string, unknown>, name = "remember") => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const post = (token: string | null, body: string) =>
    handleMcp(new Request("https://suite.test/api/m/assistant/mcp", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body }));

  it("refuses a missing, unknown or revoked token", async () => {
    const { token, clientId } = await agent();
    expect((await post(null, rpc({ fact: "x" }))).status).toBe(401);
    expect((await post("nope", rpc({ fact: "x" }))).status).toBe(401);
    await db().update(assistantAgents).set({ revokedAt: new Date() }).where(eq(assistantAgents.clientId, clientId));
    expect((await post(token, rpc({ fact: "x" }))).status).toBe(401);
    expect(fake.forwarded).toHaveLength(0);
  });

  it("records the notes an agent adds, labelled with its access", async () => {
    const { token } = await agent();
    const res = await post(token, rpc({ fact: "The oven takes 40 minutes to heat up.", kind: "fact" }));
    expect(res.status).toBe(200);
    const [row] = await db().select().from(assistantFacts);
    expect(row.source).toBe("agent");
    expect(row.sourceDetail).toBe("Claude Code on test");
    expect(row.text).toBe("The oven takes 40 minutes to heat up.");
  });

  it("never lets an agent replace the business's facts, only its own notes", async () => {
    const { owner, token } = await agent();
    const { fact, push } = await addFact(db(), { text: "Closing time is 17:30.", kind: "fact", source: "person" }, owner, business);
    await push();
    const ownerFact = (await getFact(db(), fact.id))!.fact.gbrainId!;
    const refused = await post(token, rpc({ fact: "Closing time is 22:00.", replaces: ownerFact }));
    expect(refused.status).toBe(200);
    expect(JSON.parse(await refused.text())).toMatchObject({ result: { isError: true } });
    expect(fake.forwarded).toHaveLength(0);

    // Repeating the owner's exact text gets the owner's id back: still not the agent's to replace.
    await post(token, rpc({ fact: "Closing time is 17:30." }));
    expect(await db().select().from(assistantFacts).where(eq(assistantFacts.source, "agent"))).toHaveLength(0);
    const again = await post(token, rpc({ fact: "Closing time is 23:00.", replaces: ownerFact }));
    expect(JSON.parse(await again.text())).toMatchObject({ result: { isError: true } });
    fake.forwarded = [];

    await post(token, rpc({ fact: "Note: the mixer is loud." }));
    const [mine] = (await db().select().from(assistantFacts).where(eq(assistantFacts.source, "agent"))).map((r) => r.gbrainId!);
    const allowed = await post(token, rpc({ fact: "Note: the mixer is loud before 7:00.", replaces: mine }));
    expect(fake.forwarded).toHaveLength(2);
    // The agent's own note is updated in place, its earlier wording kept.
    const notes = await db().select().from(assistantFacts).where(eq(assistantFacts.source, "agent"));
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe("Note: the mixer is loud before 7:00.");
    expect((await getFact(db(), notes[0].id))?.versions.map((v) => v.text)).toEqual(["Note: the mixer is loud."]);
    expect(JSON.parse((await allowed.text()).split("data: ")[1])).toMatchObject({ result: { content: [{ type: "text" }] } });
  });
});

describe("the assistant turn and the monthly limit", () => {
  let server: Server;
  let base = "";
  let replies: unknown[] = [];
  let calls = 0;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      for await (const _ of req) void _;
      calls += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(replies.shift() ?? { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const ai = (): ResolvedAi => ({ provider: "anthropic", baseUrl: base, model: "stand-in", apiKey: "k", maxTokens: 500, redact: true });

  it("recalls from the brain through the read tool and counts the tokens used", async () => {
    calls = 0;
    const owner = await makeUser("owner");
    const { push } = await addFact(db(), { text: "Refunds are given within 30 days with a receipt.", kind: "fact", source: "person" }, owner, business);
    await push();
    replies = [
      { content: [{ type: "tool_use", id: "tu_1", name: "recall_business_memory", input: { query: "refund" } }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 20 } },
      { content: [{ type: "text", text: "Within 30 days, with a receipt." }], stop_reason: "end_turn", usage: { input_tokens: 150, output_tokens: 10 } },
    ];
    const id = await assistantTurn(owner, "", "What is our refund policy?", ai());
    expect(id).toBeTruthy();
    expect(calls).toBe(2);
    const u = await monthUsage();
    expect(u).toMatchObject({ calls: 2, inputTokens: 250, outputTokens: 30 });
  });

  it("stops before calling the model once the token limit is reached", async () => {
    calls = 0;
    const owner = await makeUser("owner");
    await db().insert(assistantSettings).values({ id: 1 }).onConflictDoNothing();
    await saveLimits(owner, { monthlyTokenCap: 100, monthlySpendCap: null, pricePerMillionIn: null, pricePerMillionOut: null, currency: "USD", redactFacts: true });
    await recordUsage(owner, { inputTokens: 90, outputTokens: 20 });
    await expect(assistantTurn(owner, "", "Hello", ai())).rejects.toThrow(/token limit/);
    expect(calls).toBe(0);
    expect(await db().select().from(assistantUsage)).toHaveLength(1);
  });
});

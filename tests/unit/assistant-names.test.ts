import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { converse, nameRefsFor } from "@/lib/ai/assistant";
import type { ResolvedAi } from "@/lib/ai/client";
import { buildNameRefs, mapStrings } from "@/lib/ai/name-refs";
import { db } from "@/lib/db/client";
import { redactForMemory } from "@/lib/redact";
import { customerCompanies, customerContacts } from "@/modules/customers/schema";
import { makeUser, resetDb } from "./helpers";

/**
 * With redaction on, names the suite knows leave as references and come back
 * as names before a tool runs, so a lookup by a person's name works and the
 * name never reaches the provider.
 */
describe("name references", () => {
  it("round-trips known names, longest first and in any case, and leaves unknown references alone", () => {
    const refs = buildNameRefs(["Ana Reyes", "Ana", "Fern & Stone Landscaping", "x", "[person]"]);
    expect(refs.size).toBe(3);
    const out = refs.toRefs("Did ANA REYES call? Ana said Fern & Stone Landscaping's quote was late. [name:zzzzzzzz]");
    expect(out).not.toMatch(/Ana|Reyes|Fern/i);
    expect(out).toMatch(/^Did \[name:[a-z]{8}\] call\? \[name:[a-z]{8}\] said \[name:[a-z]{8}\]'s quote/);
    expect(refs.fromRefs(out)).toBe("Did Ana Reyes call? Ana said Fern & Stone Landscaping's quote was late. [name:zzzzzzzz]");
    // Same name, same reference; different names, different references.
    expect(refs.toRefs("Ana Reyes")).toBe(refs.toRefs("ana  reyes"));
    expect(refs.toRefs("Ana Reyes")).not.toBe(refs.toRefs("Ana"));
    // Only whole words: "Anabel" is not "Ana".
    expect(refs.toRefs("Anabel")).toBe("Anabel");
  });

  it("references pass redaction unchanged", () => {
    const refs = buildNameRefs(["Ana Reyes"]);
    const ref = refs.toRefs("Ana Reyes");
    expect(redactForMemory(`Call ${ref} on 555-123-4567 about the quote.`).text).toBe(`Call ${ref} on [phone] about the quote.`);
  });

  it("mapStrings keeps the shape of a tool input", () => {
    expect(mapStrings({ q: "a", n: 2, list: ["a", { b: "a" }], none: null }, (s) => s.toUpperCase())).toEqual({ q: "A", n: 2, list: ["A", { b: "A" }], none: null });
  });
});

type Reply = (body: Record<string, unknown>) => unknown;
let server: Server;
let base = "";
let replies: Reply[] = [];
let seen: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    seen.push(body);
    const next = replies.shift();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(next ? next(body) : { content: [{ type: "text", text: "no reply queued" }], stop_reason: "end_turn" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(async () => {
  await resetDb();
  replies = [];
  seen = [];
});

const ai = (redact: boolean): ResolvedAi => ({ provider: "anthropic", baseUrl: `${base}/anthropic`, model: "deepseek-flash", apiKey: "sk-test", maxTokens: 1000, redact });

/** The reference the model saw in the person's question. */
function refIn(body: Record<string, unknown>): string {
  const match = JSON.stringify(body.messages).match(/\[name:[a-z]{8}\]/);
  if (!match) throw new Error("no reference was sent");
  return match[0];
}

describe("the assistant looks a customer up by name with redaction on", () => {
  it("sends a reference, runs find_customers with the real name, and shows the name in the answer", async () => {
    const owner = await makeUser("owner", "Olive Owner");
    await db().insert(customerContacts).values({ name: "Ana Reyes", email: "ana@example.com", nameKey: "ana reyes" });
    replies = [
      (body) => ({ content: [{ type: "tool_use", id: "toolu_f", name: "find_customers", input: { query: refIn(body) } }], stop_reason: "tool_use" }),
      (body) => ({ content: [{ type: "text", text: `I found ${refIn(body)}.` }], stop_reason: "end_turn" }),
    ];
    const history = await converse(owner, [], "What did we quote Ana Reyes last time?", ai(true));

    const sent = JSON.stringify(seen);
    expect(sent).not.toContain("Ana Reyes");
    expect(sent).not.toContain("ana@example.com");
    expect(sent).not.toContain("[person] last time");
    expect(JSON.stringify(seen[0].system)).toContain("[name:");
    expect(JSON.stringify(seen[0].system)).not.toContain("Olive Owner");
    // The tool ran with the real name and found her; the model saw her as the same reference.
    const toolUse = history.flatMap((m) => m.content).find((b) => b.type === "tool_use");
    expect(toolUse && "input" in toolUse ? toolUse.input : null).toEqual({ query: "Ana Reyes" });
    const result = history.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect(result && "content" in result ? result.content : "").toContain("Ana Reyes");
    expect(JSON.stringify(seen[1].messages)).toContain(refIn(seen[0]));
    expect(history.at(-1)?.content[0]).toEqual({ type: "text", text: "I found Ana Reyes." });
  });

  it("sends no references when redaction is off, and a guest gets no customer names", async () => {
    const owner = await makeUser("owner");
    const guest = await makeUser("guest", "Gus Guest");
    await db().insert(customerCompanies).values({ name: "Fern & Stone Landscaping" });
    replies = [() => ({ content: [{ type: "text", text: "Hello." }], stop_reason: "end_turn" })];
    await converse(owner, [], "Hello Fern & Stone Landscaping", ai(false));
    expect(JSON.stringify(seen[0].messages)).toContain("Fern & Stone Landscaping");
    expect(JSON.stringify(seen[0].system)).not.toContain("[name:");

    const guestRefs = await nameRefsFor(guest);
    expect(guestRefs.toRefs("Fern & Stone Landscaping")).toBe("Fern & Stone Landscaping");
    expect(guestRefs.toRefs("Gus Guest")).toMatch(/^\[name:[a-z]{8}\]$/);
  });
});

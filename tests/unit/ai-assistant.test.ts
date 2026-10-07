import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { converse, outbound, toolsFor } from "@/lib/ai/assistant";
import { toOpenAiMessages, type ResolvedAi } from "@/lib/ai/client";
import { countRows, makeUser, resetDb } from "./helpers";

/**
 * The assistant against a local stand-in for the provider's HTTP API (both
 * wire formats). The stand-in records exactly what the suite sent.
 */
type Reply = (body: Record<string, unknown>) => unknown;
let server: Server;
let base = "";
let replies: Reply[] = [];
let seen: { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    seen.push({ path: req.url ?? "", headers: req.headers, body });
    const next = replies.shift();
    res.setHeader("content-type", "application/json");
    if (!next) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "no reply queued" }));
      return;
    }
    res.end(JSON.stringify(next(body)));
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

const anthropic = (): ResolvedAi => ({ provider: "anthropic", baseUrl: `${base}/anthropic`, model: "deepseek-flash", apiKey: "sk-test", maxTokens: 1000, redact: true });
const openai = (): ResolvedAi => ({ provider: "openai", baseUrl: `${base}/v1`, model: "llama3.1", apiKey: "", maxTokens: 1000, redact: false });

describe("assistant tool loop (Anthropic Messages format)", () => {
  it("sends thinking disabled, redacts personal details, and turns a write tool call into an approval", async () => {
    const admin = await makeUser("admin", "Dana Admin");
    replies = [
      () => ({
        content: [
          { type: "text", text: "I will draft it." },
          { type: "tool_use", id: "toolu_1", name: "post_announcement", input: { title: "Closed Friday", body: "We are closed on Friday." } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
      () => ({ content: [{ type: "text", text: "Drafted. It waits in Approvals." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } }),
    ];
    const history = await converse(admin, [], "Post that we are closed Friday. Questions to jane.doe@example.com or 555-123-4567.", anthropic());

    expect(seen[0].path).toBe("/anthropic/v1/messages");
    expect(seen[0].headers["x-api-key"]).toBe("sk-test");
    expect(seen[0].body.thinking).toEqual({ type: "disabled" });
    expect(seen[0].body.model).toBe("deepseek-flash");
    const sentText = JSON.stringify(seen[0].body.messages);
    expect(sentText).not.toContain("jane.doe@example.com");
    expect(sentText).not.toContain("555-123-4567");
    expect(sentText).toContain("[email]");
    const toolNames = (seen[0].body.tools as { name: string }[]).map((t) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(["list_announcements", "post_announcement", "post_announcements"]));

    // The write became an approval; nothing was posted.
    expect(await countRows("approvals")).toBe(1);
    expect(await countRows("announcements_posts")).toBe(0);
    const toolResult = history.find((m) => m.meta?.approvals?.length);
    expect(toolResult?.meta?.approvals?.[0].count).toBe(1);
    // The model was told it waits for a person.
    expect(JSON.stringify(seen[1].body.messages)).toContain("Nothing has changed yet");
    expect(history.at(-1)?.content[0]).toEqual({ type: "text", text: "Drafted. It waits in Approvals." });
  });

  it("a batch write tool makes ONE approval for all its records", async () => {
    const admin = await makeUser("admin");
    replies = [
      () => ({
        content: [{ type: "tool_use", id: "toolu_b", name: "post_announcements", input: { items: [1, 2, 3].map((n) => ({ title: `Item ${n}`, body: `Body ${n}` })) } }],
        stop_reason: "tool_use",
      }),
      () => ({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" }),
    ];
    await converse(admin, [], "Post three notes", anthropic());
    expect(await countRows("approvals")).toBe(1);
    expect(await countRows("approval_items")).toBe(3);
  });

  it("read tools run at once and their result goes back to the model", async () => {
    const admin = await makeUser("admin");
    replies = [
      () => ({ content: [{ type: "tool_use", id: "toolu_r", name: "list_announcements", input: { limit: 5 } }], stop_reason: "tool_use" }),
      () => ({ content: [{ type: "text", text: "There are none." }], stop_reason: "end_turn" }),
    ];
    await converse(admin, [], "What is new?", anthropic());
    const second = JSON.stringify(seen[1].body.messages);
    expect(second).toContain('"tool_result"');
    expect(second).toContain("toolu_r");
  });

  it("explains an empty reply cut off by max_tokens (thinking ate the budget)", async () => {
    const admin = await makeUser("admin");
    replies = [() => ({ content: [{ type: "thinking", thinking: "..." }], stop_reason: "max_tokens" })];
    await expect(converse(admin, [], "Hello", anthropic())).rejects.toThrow(/whole reply budget/);
  });

  it("members get no write tool for something their role cannot do, guests get no tools", async () => {
    const member = await makeUser("member");
    const guest = await makeUser("guest");
    const memberTools = (await toolsFor(member)).map((t) => t.spec.name);
    expect(memberTools).toContain("list_announcements");
    expect(memberTools).not.toContain("post_announcement");
    expect(await toolsFor(guest)).toEqual([]);
  });
});

describe("assistant tool loop (OpenAI-compatible format, e.g. a local Ollama)", () => {
  it("converts tools and tool calls both ways", async () => {
    const admin = await makeUser("admin");
    replies = [
      () => ({
        choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "post_announcement", arguments: JSON.stringify({ title: "Hi", body: "Hello all" }) } }] }, finish_reason: "tool_calls" }],
      }),
      () => ({ choices: [{ message: { content: "Waiting for approval." }, finish_reason: "stop" }] }),
    ];
    const history = await converse(admin, [], "Say hi to everyone", openai());
    expect(seen[0].path).toBe("/v1/chat/completions");
    expect(seen[0].headers.authorization).toBeUndefined();
    expect((seen[0].body.tools as { type: string }[])[0].type).toBe("function");
    const secondMessages = seen[1].body.messages as { role: string; tool_call_id?: string }[];
    expect(secondMessages.some((m) => m.role === "tool" && m.tool_call_id === "call_1")).toBe(true);
    expect(await countRows("approvals")).toBe(1);
    expect(history.at(-1)?.content[0]).toEqual({ type: "text", text: "Waiting for approval." });
  });

  it("toOpenAiMessages keeps the system prompt first", () => {
    const out = toOpenAiMessages("sys", [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1]).toEqual({ role: "user", content: "hi" });
  });
});

describe("redaction before sending", () => {
  it("keeps the business name and leaves tool ids alone", () => {
    const out = outbound(
      [{ role: "user", content: [{ type: "text", text: "Acme Bakery: call Maria Lopez on 555-987-6543" }, { type: "tool_result", tool_use_id: "toolu_9", content: "id 0b0f7c1e-1111-4222-8333-444455556666" }] }],
      true,
      ["Acme Bakery"],
    );
    const text = JSON.stringify(out);
    expect(text).toContain("Acme Bakery");
    expect(text).not.toContain("555-987-6543");
    expect(text).toContain("0b0f7c1e-1111-4222-8333-444455556666");
    expect(text).toContain("toolu_9");
  });
});

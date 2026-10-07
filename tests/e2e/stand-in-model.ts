import { createServer, type Server } from "node:http";

/**
 * A stand-in for an AI provider's Anthropic Messages API, for the browser
 * test and for running the assistant on a machine without an API key. It is
 * not a model: it follows three simple rules so the assistant's real tool loop
 * can be driven end to end.
 * - "remember …"      → calls remember_fact with the rest of the sentence;
 * - "announcement…"   → calls list_announcements;
 * - anything else     → calls recall_business_memory with the longest word;
 * - after a tool result, answers with what the tool returned.
 * Run on its own: pnpm exec tsx tests/e2e/stand-in-model.ts [port]
 */

type Block = { type: string; text?: string; content?: string; name?: string };
type Msg = { role: string; content: Block[] | string };

function reply(body: { messages?: Msg[] }) {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const blocks: Block[] = typeof last?.content === "string" ? [{ type: "text", text: last.content }] : (last?.content ?? []);
  const usage = { input_tokens: Math.ceil(JSON.stringify(messages).length / 4), output_tokens: 25 };
  const results = blocks.filter((b) => b.type === "tool_result");
  if (results.length) {
    const text = results.map((r) => r.content ?? "").join(" ");
    const answer = /Held for approval/.test(text)
      ? "I have proposed that. It waits in Approvals: nothing has changed until a person approves it."
      : `Here is what I found: ${text.slice(0, 600)}`;
    return { content: [{ type: "text", text: answer }], stop_reason: "end_turn", usage };
  }
  const question = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join(" ");
  const id = `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const remember = /remember(?: that)?\s+(.+)/i.exec(question);
  if (remember) {
    return { content: [{ type: "text", text: "I will propose that fact." }, { type: "tool_use", id, name: "remember_fact", input: { text: remember[1].trim(), kind: "fact" } }], stop_reason: "tool_use", usage };
  }
  if (/announcement/i.test(question)) {
    return { content: [{ type: "tool_use", id, name: "list_announcements", input: { limit: 5 } }], stop_reason: "tool_use", usage };
  }
  const words = question.toLowerCase().match(/[a-z]{4,}/g) ?? ["business"];
  const stop = new Set(["what", "know", "does", "about", "with", "when", "where", "have", "your", "tell", "from"]);
  const query = words.filter((w) => !stop.has(w)).sort((a, b) => b.length - a.length)[0] ?? words[0];
  return { content: [{ type: "tool_use", id, name: "recall_business_memory", input: { query: query.replace(/s$/, "") } }], stop_reason: "tool_use", usage };
}

export async function startStandInModel(port = 0): Promise<{ url: string; requests: unknown[]; close: () => Promise<void> }> {
  const requests: unknown[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: { messages?: Msg[] } = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      // answer anyway
    }
    requests.push({ path: req.url, body });
    res.setHeader("content-type", "application/json");
    if (!req.url?.endsWith("/v1/messages")) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "The stand-in only answers POST /v1/messages." }));
      return;
    }
    res.end(JSON.stringify(reply(body)));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
  return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

if (process.argv[1]?.endsWith("stand-in-model.ts")) {
  const s = await startStandInModel(Number(process.argv[2] ?? 7499));
  console.log(`Stand-in model listening at ${s.url} (Anthropic Messages format; set it as the address in Settings → AI).`);
}

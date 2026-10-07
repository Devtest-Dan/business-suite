/**
 * A minimal MCP (Streamable HTTP) client for GBrain's stateless /mcp
 * endpoint, and the pure helpers the coding-agent proxy uses. Ported from the
 * AHL brain host (services/brain-host/src/mcp-client.ts, our own code).
 * Pure apart from callTool's fetch, so the unit tests cover it directly.
 */

export class McpCallError extends Error {
  constructor(
    readonly kind: "auth" | "tool" | "transport",
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "McpCallError";
  }
}

type RpcMessage = { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> }; result?: RpcResult; error?: { code?: unknown; message?: unknown } };
type RpcResult = { isError?: boolean; content?: { type?: string; text?: string }[]; structuredContent?: unknown };

let nextId = 1;

function messagesOf(body: string): RpcMessage[] {
  try {
    const parsed: unknown = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((m): m is RpcMessage => !!m && typeof m === "object");
  } catch {
    return [];
  }
}

/** Argument names through which a `remember` call supersedes an existing fact. */
const REPLACE_KEYS = ["replaces", "replace", "supersedes", "supersede"];

/**
 * The JSON-RPC ids and target fact ids of every `remember` call in a request
 * body that asks to supersede an existing fact (top-level arguments or any
 * `items` entry). An unparseable body yields none (GBrain rejects it anyway).
 */
export function replaceRequests(body: string): { rpcId: unknown; targets: string[] }[] {
  const out: { rpcId: unknown; targets: string[] }[] = [];
  for (const m of messagesOf(body)) {
    if (m.method !== "tools/call" || m.params?.name !== "remember") continue;
    const args = m.params?.arguments ?? {};
    const holders = [args, ...(Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [])];
    const targets: string[] = [];
    for (const h of holders) {
      if (!h || typeof h !== "object") continue;
      for (const key of REPLACE_KEYS) {
        const v = h[key];
        if (v === undefined || v === null || v === "" || v === false) continue;
        // Any non-empty value asks to replace; ids we cannot read count as unknown targets.
        targets.push(typeof v === "string" ? v : JSON.stringify(v));
      }
    }
    if (targets.length) out.push({ rpcId: m.id, targets });
  }
  return out;
}

/** A JSON-RPC reply that refuses the given calls as tool errors (what the agent sees). */
export function refusalBody(body: string, rpcIds: unknown[], text: string): string {
  const refusal = (id: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result: { isError: true, content: [{ type: "text", text }] } });
  return JSON.stringify(body.trimStart().startsWith("[") ? rpcIds.map(refusal) : refusal(rpcIds[0]));
}

/** Parses a JSON or SSE (text/event-stream) MCP reply into its JSON-RPC message(s). */
export function parseReply(contentType: string, raw: string): RpcMessage | RpcMessage[] | null {
  if (contentType.includes("text/event-stream")) {
    const found: RpcMessage[] = [];
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as RpcMessage;
        if (msg && (msg.result !== undefined || msg.error !== undefined)) found.push(msg);
      } catch {
        // keep-alives and partial frames
      }
    }
    return found.length === 0 ? null : found.length === 1 ? found[0] : found;
  }
  return raw ? (JSON.parse(raw) as RpcMessage | RpcMessage[]) : null;
}

/** The JSON payload of a tool result: structuredContent, else the first text item that is JSON. */
function payloadOf(result: RpcResult): Record<string, unknown> | null {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Record<string, unknown>;
  const texts = (result.content ?? []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string);
  for (const t of texts) {
    try {
      const p: unknown = JSON.parse(t);
      if (p && typeof p === "object") return p as Record<string, unknown>;
    } catch {
      // a notice, not the result
    }
  }
  return texts.length ? { text: texts.join("\n") } : null;
}

/** One fact a coding agent saved through `remember`: GBrain's id and the text the agent sent. */
export interface RememberedFact {
  gbrainId: string;
  text: string;
  kind: string;
  /** The GBrain id this fact replaced, when the agent asked to replace one. */
  replaces?: string;
}

function replacedId(args: Record<string, unknown>): { replaces?: string } {
  for (const key of REPLACE_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v) return { replaces: v };
    if (typeof v === "number") return { replaces: String(v) };
  }
  return {};
}

/**
 * Pairs the facts in an agent's `remember` request with the ids GBrain gave
 * them, so the suite can keep its own record of what agents wrote (single
 * calls and `items` batches; JSON-RPC batches are matched by id).
 */
export function rememberedFacts(requestBody: string, contentType: string, replyBody: string): RememberedFact[] {
  const calls = messagesOf(requestBody).filter((m) => m.method === "tools/call" && m.params?.name === "remember");
  if (calls.length === 0) return [];
  let replies: RpcMessage[];
  try {
    const parsed = parseReply(contentType, replyBody);
    replies = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
  const out: RememberedFact[] = [];
  for (const call of calls) {
    const reply = replies.find((r) => r.id === call.id) ?? (calls.length === 1 && replies.length === 1 ? replies[0] : undefined);
    if (!reply?.result || reply.result.isError) continue;
    const payload = payloadOf(reply.result);
    if (!payload) continue;
    const args = call.params?.arguments ?? {};
    if (Array.isArray(payload.items) && Array.isArray(args.items)) {
      payload.items.forEach((item: unknown, i: number) => {
        const it = item as { id?: unknown; status?: unknown };
        const sent = (args.items as Record<string, unknown>[])[i];
        if (it?.id === undefined || it.id === null || it.status === "failed" || !sent) return;
        out.push({ gbrainId: String(it.id), text: String(sent.fact ?? sent.text ?? ""), kind: String(sent.kind ?? "fact"), ...replacedId(sent) });
      });
    } else if (payload.id !== undefined && payload.id !== null) {
      out.push({ gbrainId: String(payload.id), text: String(args.fact ?? args.text ?? ""), kind: String(args.kind ?? "fact"), ...replacedId(args) });
    }
  }
  return out.filter((f) => f.text.trim());
}

/**
 * Calls one tool and returns the parsed JSON payload of its result.
 * Tool-level errors (isError) become McpCallError("tool", <GBrain's code>).
 */
export async function callTool(endpoint: string, token: string, name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new McpCallError("transport", "unreachable", e instanceof Error ? e.message : "fetch failed");
  }
  const raw = await res.text();
  if (res.status === 401 || res.status === 403) throw new McpCallError("auth", "unauthorized", "token refused", res.status);
  if (!res.ok) throw new McpCallError("transport", `http_${res.status}`, `MCP endpoint answered ${res.status}`, res.status);
  let parsed: RpcMessage | RpcMessage[] | null;
  try {
    parsed = parseReply(res.headers.get("content-type") ?? "", raw);
  } catch {
    throw new McpCallError("transport", "bad_reply", "MCP reply was not JSON");
  }
  const msg = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  if (!msg) throw new McpCallError("transport", "bad_reply", "empty MCP reply");
  if (msg.error) throw new McpCallError("tool", String(msg.error.code ?? "rpc_error"), String(msg.error.message ?? "MCP error"));
  const result = msg.result ?? {};
  const payload = payloadOf(result) ?? {};
  if (result.isError) {
    const err = payload.error as { code?: unknown; message?: unknown } | string | undefined;
    const code = (typeof err === "object" ? err?.code : err) ?? payload.code ?? "tool_error";
    const message = payload.message ?? (typeof err === "object" ? err?.message : undefined) ?? payload.text ?? "tool call failed";
    throw new McpCallError("tool", String(code), String(message));
  }
  return payload;
}

import "server-only";
import { unseal } from "@/lib/crypto";
import { UserError } from "@/lib/errors";
import { getSetting, type AiSettings } from "@/lib/settings";

/**
 * The one model client, provider-agnostic. Two wire formats:
 * - "anthropic": the Anthropic Messages API. The default is DeepSeek's
 *   Anthropic-compatible endpoint (https://api.deepseek.com/anthropic) with
 *   thinking switched off: DeepSeek thinks by default and the thinking counts
 *   against max_tokens, which leaves long replies empty.
 * - "openai": the OpenAI Chat Completions format, for a local Ollama
 *   (http://localhost:11434/v1) or any compatible server.
 * Messages use Anthropic-style blocks inside the suite; the OpenAI adapter
 * converts on the way out and back.
 */

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type Block = TextBlock | ToolUseBlock | ToolResultBlock;
export interface ChatMessage {
  role: "user" | "assistant";
  content: Block[];
}
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface ModelReply {
  blocks: (TextBlock | ToolUseBlock)[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}
export interface CompleteRequest {
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
}

export class AiError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

export interface ResolvedAi {
  provider: "anthropic" | "openai";
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  redact: boolean;
}

export async function resolveAi(saved?: AiSettings): Promise<ResolvedAi | null> {
  const s = saved ?? (await getSetting("ai"));
  if (s.provider === "none") return null;
  return {
    provider: s.provider,
    baseUrl: s.baseUrl.replace(/\/+$/, ""),
    model: s.model,
    apiKey: s.apiKey ? unseal(s.apiKey) : "",
    maxTokens: s.maxTokens,
    redact: s.redact,
  };
}

const TIMEOUT_MS = 90_000;

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new AiError(`The AI provider at ${new URL(url).host} could not be reached (${error instanceof Error ? error.message : "network error"}). Check the address in Settings → AI.`);
  }
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " Check the API key in Settings → AI." : res.status === 404 ? " Check the address and model name in Settings → AI." : res.status === 429 ? " The provider is rate-limiting this key; wait a minute and try again." : "";
    throw new AiError(`The AI provider answered ${res.status}.${hint} (${text.slice(0, 200)})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError("The AI provider sent a reply that is not JSON. Check the address in Settings → AI.");
  }
}

// ── Anthropic Messages API ───────────────────────────────────────────────────

async function completeAnthropic(ai: ResolvedAi, req: CompleteRequest): Promise<ModelReply> {
  const json = (await post(
    `${ai.baseUrl}/v1/messages`,
    { "x-api-key": ai.apiKey, "anthropic-version": "2023-06-01" },
    {
      model: ai.model,
      max_tokens: req.maxTokens ?? ai.maxTokens,
      system: req.system,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      // Thinking off: on DeepSeek it is on by default and eats max_tokens.
      thinking: { type: "disabled" },
    },
  )) as { content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  const blocks: ModelReply["blocks"] = [];
  for (const b of json.content ?? []) {
    if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
    if (b.type === "tool_use" && b.id && b.name) blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
  }
  return finish(blocks, json.stop_reason ?? "", json.usage?.input_tokens ?? 0, json.usage?.output_tokens ?? 0);
}

// ── OpenAI Chat Completions (Ollama and compatible servers) ──────────────────

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function toOpenAiMessages(system: string, messages: ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n");
      const calls = m.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
      });
      continue;
    }
    for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
    const text = m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

async function completeOpenAi(ai: ResolvedAi, req: CompleteRequest): Promise<ModelReply> {
  const json = (await post(
    `${ai.baseUrl}/chat/completions`,
    ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {},
    {
      model: ai.model,
      max_tokens: req.maxTokens ?? ai.maxTokens,
      messages: toOpenAiMessages(req.system, req.messages),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
    },
  )) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = json.choices?.[0];
  const blocks: ModelReply["blocks"] = [];
  if (choice?.message?.content) blocks.push({ type: "text", text: choice.message.content });
  for (const [i, call] of (choice?.message?.tool_calls ?? []).entries()) {
    if (!call.function?.name) continue;
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: call.id || `call_${i}`, name: call.function.name, input });
  }
  const reason = choice?.finish_reason === "length" ? "max_tokens" : choice?.finish_reason === "tool_calls" ? "tool_use" : choice?.finish_reason ?? "";
  return finish(blocks, reason, json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0);
}

function finish(blocks: ModelReply["blocks"], stopReason: string, inputTokens: number, outputTokens: number): ModelReply {
  if (blocks.length === 0) {
    throw new AiError(
      stopReason === "max_tokens"
        ? "The model used its whole reply budget without answering (on some providers, thinking counts against it). Raise “Longest reply” in Settings → AI, or pick a model without thinking."
        : "The model returned an empty reply. Try again, or check the model name in Settings → AI.",
    );
  }
  return { blocks, stopReason, usage: { inputTokens, outputTokens } };
}

export async function complete(ai: ResolvedAi, req: CompleteRequest): Promise<ModelReply> {
  return ai.provider === "anthropic" ? completeAnthropic(ai, req) : completeOpenAi(ai, req);
}

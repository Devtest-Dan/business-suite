import Link from "next/link";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { toolsFor, type StoredMessage } from "@/lib/ai/assistant";
import { resolveAi } from "@/lib/ai/client";
import type { ModulePageProps } from "@/lib/modules/contract";
import { sendMessage } from "../actions";
import { conversation, recentConversations } from "../chat";
import { P } from "../ids";
import { capReached, monthUsage, readLimits } from "../usage";

type ToolInfo = { module: string; kind: "read" | "write" };

function Message({ m, tools }: { m: StoredMessage; tools: Map<string, ToolInfo> }) {
  const texts = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
  const calls = m.content.filter((b) => b.type === "tool_use") as { name: string; input: unknown }[];
  const results = m.content.filter((b) => b.type === "tool_result");
  if (m.role === "user" && results.length) {
    return m.meta?.approvals?.length ? (
      <div className="notice notice-warn" data-testid="held-for-approval">
        {m.meta.approvals.map((a) => (
          <p key={a.id}>
            Held for approval: {a.title} ({a.count} record{a.count === 1 ? "" : "s"}). Nothing has changed yet.{" "}
            <Link className="link font-medium" href={`/approvals/${a.id}`}>
              Open it
            </Link>
          </p>
        ))}
      </div>
    ) : null;
  }
  return (
    <div className={m.role === "user" ? "ml-auto max-w-[85%] rounded-xl bg-accent-soft px-4 py-2" : "max-w-[90%] space-y-1"}>
      {texts.map((t, i) => (
        <p key={i} className="whitespace-pre-line break-words">
          {t}
        </p>
      ))}
      {calls.length ? (
        <details className="text-xs text-subtle" data-testid="tools-used">
          <summary className="cursor-pointer">
            Used {calls.length === 1 ? "a tool" : `${calls.length} tools`}:{" "}
            {calls
              .map((c) => {
                const info = tools.get(c.name);
                return `${c.name}${info ? ` (${info.module}, ${info.kind === "read" ? "looked up" : "proposed a change"})` : ""}`;
              })
              .join(", ")}
          </summary>
          <ul className="mt-1 space-y-1">
            {calls.map((c, i) => (
              <li key={i} className="break-all font-mono">
                {c.name} {JSON.stringify(c.input ?? {}).slice(0, 300)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export async function ChatPage({ ctx, searchParams, basePath }: ModulePageProps) {
  const id = z.string().uuid().safeParse(searchParams.c).data;
  const [ai, current, recent, bound, limits] = await Promise.all([
    resolveAi().catch(() => null),
    conversation(ctx.viewer, id),
    recentConversations(ctx.viewer),
    toolsFor(ctx.viewer),
    readLimits(),
  ]);
  const usage = await monthUsage(undefined, limits);
  const paused = capReached(limits, usage);
  const tools = new Map<string, ToolInfo>(bound.map((t) => [t.spec.name, { module: t.module.name, kind: t.kind }]));
  const apps = [...new Set(bound.map((t) => t.module.name))];
  const messages = (current?.messages ?? []) as StoredMessage[];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_14rem]">
      <div className="min-w-0 space-y-4">
        <header className="space-y-1">
          <h1 className="h1">Assistant</h1>
          <p className="muted text-sm">
            Ask about anything in your apps. It looks things up straight away; anything it wants to change waits in Approvals for a person.
            {apps.length ? ` It can use ${bound.length} tools from: ${apps.join(", ")}.` : " No app gives it tools yet."}
          </p>
        </header>
        {!ai ? (
          <p className="notice notice-warn">No AI provider is set up yet. The owner can choose one in Settings → AI.</p>
        ) : paused ? (
          <p className="notice notice-warn" data-testid="limit-reached">
            The assistant is paused: this month&apos;s {paused === "tokens" ? "token" : "spend"} limit is used up.{" "}
            {ctx.can(P.limits) ? (
              <Link className="link font-medium" href={`${basePath}/settings`}>
                Change the limit
              </Link>
            ) : (
              "The owner can raise it."
            )}
          </p>
        ) : null}
        <div className="card min-h-40 space-y-4" data-testid="conversation">
          {messages.length === 0 ? (
            <p className="muted">
              Try: “What do we know about refunds?”, “What are the latest announcements?” or “Remember that the office closes early on Fridays.”
            </p>
          ) : null}
          {messages.map((m, i) => (
            <Message key={i} m={m} tools={tools} />
          ))}
        </div>
        {ai && !paused ? (
          <ActionForm action={sendMessage} submit="Send" className="space-y-2">
            <input type="hidden" name="conversationId" value={current?.id ?? ""} />
            <textarea name="message" required rows={3} maxLength={4000} className="input" aria-label="Message" placeholder="Ask or request something" />
            <p className="hint">What you send goes to the AI provider the owner chose{ai.redact ? ", with personal details replaced first" : ""}.</p>
          </ActionForm>
        ) : null}
      </div>
      <aside className="space-y-3">
        <Link href={basePath} className="btn w-full">
          New conversation
        </Link>
        <ul className="space-y-1 text-sm">
          {recent.map((c) => (
            <li key={c.id}>
              <Link href={`${basePath}?c=${c.id}`} className={`block truncate rounded px-2 py-1 hover:bg-surface-2 ${c.id === current?.id ? "font-medium text-accent" : ""}`}>
                {c.title}
              </Link>
            </li>
          ))}
        </ul>
        {ctx.can(P.recall) ? (
          <Link href={`${basePath}/facts`} className="link block text-sm">
            What the assistant knows →
          </Link>
        ) : null}
      </aside>
    </div>
  );
}

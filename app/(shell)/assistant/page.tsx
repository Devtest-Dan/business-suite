import { and, desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { enabledModules } from "@/lib/modules/registry-access";
import { ActionForm } from "@/components/action-form";
import { toolsFor, type StoredMessage } from "@/lib/ai/assistant";
import { resolveAi } from "@/lib/ai/client";
import { can, requireViewer } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { aiConversations } from "@/lib/db/schema";
import { sendToAssistant } from "./actions";

export const metadata: Metadata = { title: "Assistant" };

function Message({ m }: { m: StoredMessage }) {
  const texts = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
  const calls = m.content.filter((b) => b.type === "tool_use").map((b) => (b as { name: string }).name);
  const results = m.content.filter((b) => b.type === "tool_result");
  if (m.role === "user" && results.length) {
    return m.meta?.approvals?.length ? (
      <div className="notice notice-warn">
        {m.meta.approvals.map((a) => (
          <p key={a.id}>
            Held for approval: {a.title} ({a.count} record{a.count === 1 ? "" : "s"}).{" "}
            <Link className="link font-medium" href={`/approvals/${a.id}`}>
              Open it
            </Link>
          </p>
        ))}
      </div>
    ) : null;
  }
  return (
    <div className={m.role === "user" ? "ml-auto max-w-[85%] rounded-xl bg-accent-soft px-4 py-2" : "max-w-[90%]"}>
      {texts.map((t, i) => (
        <p key={i} className="whitespace-pre-line">
          {t}
        </p>
      ))}
      {calls.length ? <p className="text-xs text-subtle">Used: {calls.join(", ")}</p> : null}
    </div>
  );
}

export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const viewer = await requireViewer();
  // With the Assistant app switched on, its chat (with the brain and the owner's monthly limit) is the one to use.
  if ((await enabledModules()).some((m) => m.id === "assistant")) {
    const c = z.string().uuid().safeParse((await searchParams).c).data;
    redirect(c ? `/m/assistant?c=${c}` : "/m/assistant");
  }
  if (!(await can(viewer, "assistant.use"))) {
    return <p className="card muted">Your role does not include the assistant. Ask the owner.</p>;
  }
  const ai = await resolveAi().catch(() => null);
  const id = z.string().uuid().safeParse((await searchParams).c).data;
  const [current] = id ? await db().select().from(aiConversations).where(and(eq(aiConversations.id, id), eq(aiConversations.userId, viewer.id))) : [];
  const recent = await db()
    .select({ id: aiConversations.id, title: aiConversations.title })
    .from(aiConversations)
    .where(eq(aiConversations.userId, viewer.id))
    .orderBy(desc(aiConversations.updatedAt))
    .limit(10);
  const tools = await toolsFor(viewer);
  const messages = (current?.messages ?? []) as StoredMessage[];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_14rem]">
      <div className="space-y-4">
        <header>
          <h1 className="h1">Assistant</h1>
          <p className="muted text-sm">
            Ask about anything in the suite. It can look things up; anything it wants to change waits in Approvals for a person.
            {tools.length ? ` It can use ${tools.length} tools from your apps.` : ""}
          </p>
        </header>
        {!ai ? (
          <p className="notice notice-warn">No AI provider is set up yet. The owner can choose one in Settings → AI.</p>
        ) : (
          <>
            <div className="card min-h-40 space-y-4" data-testid="conversation">
              {messages.length === 0 ? <p className="muted">Try: “What are the latest announcements?” or “Draft an announcement that the office closes early on Friday.”</p> : null}
              {messages.map((m, i) => (
                <Message key={i} m={m} />
              ))}
            </div>
            <ActionForm action={sendToAssistant} submit="Send" className="space-y-2">
              <input type="hidden" name="conversationId" value={current?.id ?? ""} />
              <textarea name="message" required rows={3} maxLength={4000} className="input" aria-label="Message" placeholder="Ask or request something" />
            </ActionForm>
          </>
        )}
      </div>
      <aside className="space-y-2">
        <Link href="/assistant" className="btn w-full">
          New conversation
        </Link>
        <ul className="space-y-1 text-sm">
          {recent.map((c) => (
            <li key={c.id}>
              <Link href={`/assistant?c=${c.id}`} className={`block truncate rounded px-2 py-1 hover:bg-surface-2 ${c.id === current?.id ? "font-medium text-accent" : ""}`}>
                {c.title}
              </Link>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

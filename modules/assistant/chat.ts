import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { converse, type StoredMessage } from "@/lib/ai/assistant";
import type { ResolvedAi } from "@/lib/ai/client";
import { db } from "@/lib/db/client";
import { aiConversations } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { Viewer } from "@/lib/modules/contract";
import { assertUnderCap, recordUsage } from "./usage";

/**
 * One assistant turn: the shell's tool loop (lib/ai/assistant.ts) with the
 * owner's monthly limit checked before every model call and the provider's
 * token counts recorded after it. Conversations are the shell's own
 * (ai_conversations), private to the person.
 */
export async function assistantTurn(viewer: Viewer, conversationId: string, message: string, aiOverride?: ResolvedAi): Promise<string> {
  let history: StoredMessage[] = [];
  if (conversationId) {
    const [row] = await db()
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, viewer.id)));
    if (!row) throw new UserError("That conversation is gone. Start a new one.");
    history = row.messages as StoredMessage[];
  }
  await assertUnderCap();
  const messages = await converse(viewer, history, message, aiOverride, {
    beforeModelCall: assertUnderCap,
    afterModelCall: (usage) => recordUsage(viewer, usage),
  });
  if (conversationId) {
    await db().update(aiConversations).set({ messages, updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
    return conversationId;
  }
  const [row] = await db()
    .insert(aiConversations)
    .values({ userId: viewer.id, title: message.slice(0, 80), messages })
    .returning({ id: aiConversations.id });
  return row.id;
}

export async function conversation(viewer: Viewer, id: string | undefined) {
  if (!id) return null;
  const [row] = await db()
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, viewer.id)));
  return row ?? null;
}

export async function recentConversations(viewer: Viewer, limit = 12) {
  return db()
    .select({ id: aiConversations.id, title: aiConversations.title, updatedAt: aiConversations.updatedAt })
    .from(aiConversations)
    .where(eq(aiConversations.userId, viewer.id))
    .orderBy(desc(aiConversations.updatedAt))
    .limit(limit);
}

/** Which tools a stored conversation used, in order, with their inputs (for the "tools used" list). */
export function toolsUsed(messages: StoredMessage[]): { name: string; input: string }[] {
  const out: { name: string; input: string }[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") out.push({ name: b.name, input: JSON.stringify(b.input ?? {}).slice(0, 200) });
    }
  }
  return out;
}

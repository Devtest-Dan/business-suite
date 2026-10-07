"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { converse, type StoredMessage } from "@/lib/ai/assistant";
import { requirePermission } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { aiConversations } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import { formAction } from "@/lib/forms";
import { assistantSchema } from "@/lib/schemas";

export const sendToAssistant = formAction(assistantSchema, async ({ conversationId, message }) => {
  const viewer = await requirePermission("assistant.use");
  let history: StoredMessage[] = [];
  if (conversationId) {
    const [row] = await db()
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, viewer.id)));
    if (!row) throw new UserError("That conversation is gone. Start a new one.");
    history = row.messages as StoredMessage[];
  }
  const messages = await converse(viewer, history, message);
  let id = conversationId;
  if (id) {
    await db().update(aiConversations).set({ messages, updatedAt: new Date() }).where(eq(aiConversations.id, id));
  } else {
    const [row] = await db()
      .insert(aiConversations)
      .values({ userId: viewer.id, title: message.slice(0, 80), messages })
      .returning({ id: aiConversations.id });
    id = row.id;
  }
  redirect(`/assistant?c=${id}`);
});

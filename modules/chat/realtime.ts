import "server-only";
import { sql } from "drizzle-orm";
import type { Db, DbTx } from "@/lib/db/client";
import { sqlClient } from "@/lib/db/client";

/**
 * Live updates without a websocket server: every change runs
 * `pg_notify('chat_events', …)` inside its transaction (Postgres delivers it
 * only if the transaction commits), one LISTEN connection per server process
 * receives them, and each open browser gets the ones for conversations it
 * can read over Server-Sent Events. A browser that reconnects catches up from
 * its cursor (the highest `seq` it has seen), so nothing is lost while it was
 * away.
 */

export const PG_CHANNEL = "chat_events";

export type ChatEvent =
  /** A message changed (k = "m"): c = conversation, s = its new seq, p = thread root if it is a reply. */
  | { k: "m"; c: string; s: number; p?: string | null }
  /** Membership or the conversation itself changed (joined, left, renamed, archived): refresh lists. */
  | { k: "c"; c: string; u?: string[] }
  /** Someone read a conversation: only their own other tabs care (unread badges). */
  | { k: "r"; c: string; u: string[] };

export async function publish(db: Db | DbTx, event: ChatEvent): Promise<void> {
  await db.execute(sql`select pg_notify(${PG_CHANNEL}, ${JSON.stringify(event)})`);
}

type Listener = (event: ChatEvent) => void;

interface Hub {
  listeners: Set<Listener>;
  started?: Promise<void>;
}

const globalForHub = globalThis as unknown as { chatHub?: Hub };

function hub(): Hub {
  globalForHub.chatHub ??= { listeners: new Set() };
  return globalForHub.chatHub;
}

/** Starts the one LISTEN connection (postgres.js reconnects it by itself). */
async function ensureListening(): Promise<void> {
  const h = hub();
  h.started ??= sqlClient()
    .listen(PG_CHANNEL, (payload) => {
      let event: ChatEvent;
      try {
        event = JSON.parse(payload) as ChatEvent;
      } catch {
        return;
      }
      for (const listener of h.listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error("A chat stream listener failed:", error);
        }
      }
    })
    .then(() => undefined)
    .catch((error: unknown) => {
      h.started = undefined;
      throw error;
    });
  await h.started;
}

export async function subscribe(listener: Listener): Promise<() => void> {
  await ensureListening();
  hub().listeners.add(listener);
  return () => {
    hub().listeners.delete(listener);
  };
}

export function listenerCount(): number {
  return hub().listeners.size;
}

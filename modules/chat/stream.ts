import "server-only";
import { sql } from "drizzle-orm";
import type { ModuleContext } from "@/lib/modules/contract";
import { readableBy, readableChannelIds } from "./data";
import { subscribe, type ChatEvent } from "./realtime";

const HEARTBEAT_MS = 25_000;
/** Browsers reconnect after this many milliseconds when the stream drops. */
const RETRY_MS = 3_000;

/**
 * GET /api/m/chat/events: the live stream for one browser tab. Sends only
 * events about conversations the person can read. On reconnect the browser
 * sends Last-Event-ID (the highest seq it saw) and gets one event per
 * conversation that changed meanwhile, so it can fetch the changes.
 */
export async function eventStream(request: Request, { ctx }: { ctx: ModuleContext }): Promise<Response> {
  const viewer = ctx.viewer;
  let visible = await readableChannelIds(ctx.db, viewer);
  const lastId = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("cursor") ?? "");
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<void> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      request.signal.addEventListener("abort", close);

      send(`retry: ${RETRY_MS}\n\n`);
      send(`event: ready\ndata: {}\n\n`);

      const deliver = (event: ChatEvent) => {
        if (event.k === "m") {
          const line = `id: ${event.s}\ndata: ${JSON.stringify(event)}\n\n`;
          // While the list of readable conversations is being refreshed (someone was just added), wait for it.
          if (refreshing) void refreshing.then(() => visible.has(event.c) && send(line));
          else if (visible.has(event.c)) send(line);
          return;
        }
        if (event.k === "r") {
          if (event.u.includes(viewer.id)) send(`data: ${JSON.stringify(event)}\n\n`);
          return;
        }
        // Membership changed: recompute what this person can read, then tell them if it concerns them.
        refreshing ??= readableChannelIds(ctx.db, viewer)
          .then((ids) => {
            visible = ids;
          })
          .catch(() => {})
          .finally(() => {
            refreshing = null;
          });
        void refreshing.then(() => {
          if (visible.has(event.c) || event.u?.includes(viewer.id)) send(`data: ${JSON.stringify(event)}\n\n`);
        });
      };

      try {
        unsubscribe = await subscribe(deliver);
      } catch (error) {
        console.error("The chat live stream could not listen to the database:", error);
        send(`event: unavailable\ndata: {}\n\n`);
        close();
        return;
      }

      // Catch up: one event per conversation that changed after the browser's cursor.
      if (Number.isFinite(lastId) && lastId > 0) {
        const rows = await ctx.db.execute<{ channel_id: string; s: number }>(sql`
          select m.channel_id, max(m.seq)::bigint as s from chat_messages m join chat_channels c on c.id = m.channel_id
          where m.seq > ${lastId} and ${readableBy(viewer, sql`c.id`, sql`c.kind`)}
          group by m.channel_id`);
        for (const r of rows) send(`id: ${Number(r.s)}\ndata: ${JSON.stringify({ k: "m", c: r.channel_id, s: Number(r.s) })}\n\n`);
      }

      heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tell proxies (nginx-style) not to buffer; Caddy flushes event streams by itself.
      "x-accel-buffering": "no",
    },
  });
}

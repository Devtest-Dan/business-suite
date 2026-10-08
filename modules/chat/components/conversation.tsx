"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { fetchChanges, fetchOlder, markReadAction, sendMessage } from "../actions";
import type { MessageView } from "../data";
import { sourceLabel } from "../text";
import { Composer } from "./composer";
import { useLive } from "./live";
import { MessageItem, type ItemOptions } from "./message-item";

/** Sequence numbers a reconnecting tab re-reads, in case a change committed out of order. */
const RECONNECT_OVERLAP = 100;

function dayLabel(iso: string, tz: string): string {
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  try {
    const day = fmt(new Date(iso));
    if (day === fmt(new Date())) return "Today";
    if (day === fmt(new Date(Date.now() - 86_400_000))) return "Yesterday";
    return new Intl.DateTimeFormat("en", { dateStyle: "full", timeZone: tz }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function sameDay(a: string, b: string, tz: string): boolean {
  return dayLabel(a, tz) === dayLabel(b, tz);
}

export interface ConversationProps extends Omit<ItemOptions, "inThread"> {
  channelId: string;
  /** Set for a thread view: the thread's first message id. */
  parentId: string | null;
  initial: MessageView[];
  more: boolean;
  lastReadCseq: number;
  highlightId: string | null;
  placeholder: string;
  allowChannelMention: boolean;
  canAttach: boolean;
  /** Shown instead of the message box (archived, or not in the conversation). */
  blocked: ReactNode;
}

export function Conversation(props: ConversationProps) {
  const { channelId, parentId, viewerId, timezone } = props;
  const [messages, setMessages] = useState<MessageView[]>(props.initial);
  const [more, setMore] = useState(props.more);
  const [below, setBelow] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const cursor = useRef(Math.max(0, ...props.initial.map((m) => m.seq)));
  const lastSentRead = useRef(props.lastReadCseq);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // Fixed on arrival: where the "New messages" line goes and how many there were.
  const [firstUnread] = useState<string | null>(() => props.initial.find((m) => !m.parentId && m.cseq > props.lastReadCseq && m.authorId !== viewerId)?.id ?? null);
  const [unreadAtLoad] = useState(() => props.initial.filter((m) => !m.parentId && m.cseq > props.lastReadCseq && m.authorId !== viewerId).length);
  const [showJump, setShowJump] = useState(Boolean(firstUnread && !props.highlightId));

  const merge = useCallback((incoming: MessageView[]) => {
    if (incoming.length === 0) return 0;
    cursor.current = Math.max(cursor.current, ...incoming.map((m) => m.seq));
    let added = 0;
    setMessages((current) => {
      const byId = new Map(current.map((m) => [m.id, m]));
      for (const m of incoming) {
        if (!byId.has(m.id)) added += 1;
        const old = byId.get(m.id);
        if (!old || old.seq <= m.seq) byId.set(m.id, m);
      }
      return [...byId.values()].sort((a, b) => a.cseq - b.cseq);
    });
    return added;
  }, []);

  const pull = useCallback(
    async (since: number) => {
      const r = await fetchChanges({ channelId, parentId, cursor: Math.max(0, since) });
      if (!r.ok) return;
      merge(r.messages);
      if (!atBottom.current && r.messages.some((m) => m.authorId !== viewerId && m.cseq > lastSentRead.current)) setBelow((n) => n + 1);
    },
    [channelId, parentId, merge, viewerId],
  );

  useLive((e) => {
    if (e.k === "reconnected") void pull(cursor.current - RECONNECT_OVERLAP);
    else if (e.k === "m" && e.c === channelId) {
      // A reply (e.p set) also changes its thread's first message (reply count), so the channel view re-reads too.
      const relevant = parentId ? e.p === parentId || !e.p : true;
      if (relevant) void pull(Math.min(cursor.current, e.s - 1));
    }
  });

  // Where to start: the linked message, else the first unread one, else the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const target = props.highlightId ?? firstUnread;
    const node = target ? document.getElementById(target === firstUnread && !props.highlightId ? "unread-divider" : `msg-${target}`) : null;
    if (node) node.scrollIntoView({ block: "center" });
    else el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only once, on arrival
  }, []);

  // New messages at the bottom stay in view when you are already at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Reading: once the newest message is on screen and the tab is visible, move the read marker.
  useEffect(() => {
    if (parentId) return;
    const send = () => {
      if (document.visibilityState !== "visible" || !atBottom.current) return;
      const newest = Math.max(0, ...messages.filter((m) => !m.parentId).map((m) => m.cseq));
      if (newest > lastSentRead.current) {
        lastSentRead.current = newest;
        void markReadAction({ channelId, cseq: newest });
      }
    };
    send();
    document.addEventListener("visibilitychange", send);
    return () => document.removeEventListener("visibilitychange", send);
  }, [messages, channelId, parentId]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (bottom && !atBottom.current) {
      setBelow(0);
      const newest = Math.max(0, ...messages.filter((m) => !m.parentId).map((m) => m.cseq));
      if (!parentId && newest > lastSentRead.current && document.visibilityState === "visible") {
        lastSentRead.current = newest;
        void markReadAction({ channelId, cseq: newest });
      }
    }
    atBottom.current = bottom;
  }

  async function older() {
    const first = messages.find((m) => (parentId ? m.id !== parentId : true));
    if (!first) return;
    setLoadingOlder(true);
    const el = scroller.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    const r = await fetchOlder({ channelId, parentId, beforeCseq: first.cseq });
    setLoadingOlder(false);
    if (!r.ok) return;
    setMore(r.more);
    merge(r.messages);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  }

  async function onSend(body: string, files: { fileId: string; name: string; mime: string; size: number }[], clientKey: string): Promise<string | null> {
    const r = await sendMessage({ channelId, parentId, body, fileIds: files.map((f) => f.fileId), clientKey });
    if (!r.ok) return r.error;
    atBottom.current = true;
    merge([r.message]);
    return null;
  }

  const options: ItemOptions = {
    viewerId,
    people: props.people,
    timezone,
    canPost: props.canPost,
    canModerate: props.canModerate,
    crossApps: props.crossApps,
    base: props.base,
    inThread: Boolean(parentId),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showJump ? (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-accent-soft px-3 py-1.5 text-sm text-accent">
          <span>
            {unreadAtLoad === 1 ? "1 new message" : `${unreadAtLoad} new messages`} since you last looked.
          </span>
          <span className="flex gap-3">
            <button type="button" className="font-medium underline" onClick={() => document.getElementById("unread-divider")?.scrollIntoView({ block: "center", behavior: "smooth" })}>
              Jump to unread
            </button>
            <button type="button" className="underline" onClick={() => setShowJump(false)}>
              Dismiss
            </button>
          </span>
        </div>
      ) : null}
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto pr-1" data-testid="message-list" aria-live="polite">
        {more ? (
          <div className="py-2 text-center">
            <button type="button" className="btn" onClick={() => void older()} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : "Show earlier messages"}
            </button>
          </div>
        ) : messages.length ? (
          <p className="py-3 text-center text-xs text-subtle">{parentId ? "The start of this thread." : "The start of this conversation."}</p>
        ) : null}
        {messages.length === 0 ? <p className="muted py-10 text-center">No messages yet. Say hello.</p> : null}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || !sameDay(prev.createdAt, m.createdAt, timezone);
          const compact =
            !newDay &&
            Boolean(prev) &&
            prev.authorId === m.authorId &&
            prev.authorName === m.authorName &&
            sourceLabel(prev) === sourceLabel(m) &&
            !prev.deleted &&
            new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000 &&
            !(parentId && prev.id === parentId) &&
            m.id !== firstUnread;
          return (
            <div key={m.id}>
              {newDay ? (
                <div className="my-3 flex items-center gap-3 text-xs font-medium text-subtle" role="separator">
                  <span className="h-px flex-1 bg-line" />
                  {dayLabel(m.createdAt, timezone)}
                  <span className="h-px flex-1 bg-line" />
                </div>
              ) : null}
              {m.id === firstUnread ? (
                <div id="unread-divider" className="my-2 flex items-center gap-3 text-xs font-semibold text-danger" role="separator" data-testid="unread-divider">
                  <span className="h-px flex-1" style={{ background: "var(--danger)" }} />
                  New messages
                  <span className="h-px flex-1" style={{ background: "var(--danger)" }} />
                </div>
              ) : null}
              <MessageItem m={m} compact={compact} highlight={m.id === props.highlightId} o={options} onChanged={() => void pull(cursor.current)} />
              {parentId && m.id === parentId ? (
                <div className="my-2 flex items-center gap-3 text-xs text-subtle">
                  <span>{m.replyCount === 1 ? "1 reply" : `${m.replyCount} replies`}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {below > 0 ? (
        <button
          type="button"
          className="btn btn-primary mx-auto -mt-12 mb-2 shadow"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
        >
          New messages below ↓
        </button>
      ) : null}
      <div className="pt-2">
        {props.blocked ?? (
          <Composer placeholder={props.placeholder} people={props.people} allowChannelMention={props.allowChannelMention} canAttach={props.canAttach} onSend={onSend} />
        )}
      </div>
    </div>
  );
}

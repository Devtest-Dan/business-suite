"use client";

import Link from "next/link";
import { useState } from "react";
import { crossAppAction, deleteMessageAction, editMessageAction, pinAction, reactAction } from "../actions";
import type { MessageView } from "../data";
import { REACTIONS, type Person, type Reaction } from "../text";
import { Attachments, LinkCard, MessageText } from "./message-body";

export interface ItemOptions {
  viewerId: string;
  people: Person[];
  timezone: string;
  canPost: boolean;
  canModerate: boolean;
  crossApps: { task: boolean; doc: boolean };
  base: string;
  /** In a thread view the "Reply in thread" link is not shown. */
  inThread: boolean;
}

function time(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en", { timeStyle: "short", timeZone: tz }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleTimeString();
  }
}

function full(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "full", timeStyle: "short", timeZone: tz }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function MessageItem({ m, compact, highlight, o, onChanged }: { m: MessageView; compact: boolean; highlight: boolean; o: ItemOptions; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [note, setNote] = useState<{ text: string; url?: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = m.authorId === o.viewerId;

  async function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setNote({ text: r.error ?? "That did not work. Try again.", error: true });
    else onChanged();
    return r.ok;
  }

  const threadUrl = `${o.base}/${m.channelId}/thread/${m.parentId ?? m.id}`;
  return (
    <article
      id={`msg-${m.id}`}
      data-testid="message"
      data-message-id={m.id}
      className={`group relative rounded-lg px-2 py-1 hover:bg-surface-2 ${compact ? "" : "mt-2"} ${highlight ? "ring-2 ring-accent" : ""}`}
    >
      {!compact ? (
        <header className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">{m.authorName}</span>
          {m.via === "ai" ? <span className="badge">drafted by the assistant</span> : m.via === "import" ? <span className="badge">from Slack</span> : null}
          <time dateTime={m.createdAt} title={full(m.createdAt, o.timezone)} className="text-xs text-subtle">
            {time(m.createdAt, o.timezone)}
          </time>
          {m.pinned ? <span className="badge badge-accent">Pinned</span> : null}
        </header>
      ) : m.pinned ? (
        <span className="badge badge-accent">Pinned</span>
      ) : null}

      {m.deleted ? (
        <p className="text-sm italic text-subtle">This message was deleted.</p>
      ) : editing ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act(() => editMessageAction({ messageId: m.id, body: draft }))) setEditing(false);
          }}
        >
          <textarea className="input" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit message" autoFocus />
          <div className="flex gap-2">
            <button className="btn btn-primary" type="submit" disabled={busy || !draft.trim()}>
              Save
            </button>
            <button className="btn" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {m.body ? (
            <div className="text-[0.95rem]">
              <MessageText body={m.body} people={o.people} viewerId={o.viewerId} />
              {m.editedAt ? (
                <span className="text-xs text-subtle" title={`Edited ${full(m.editedAt, o.timezone)}`}>
                  {" "}
                  (edited)
                </span>
              ) : null}
            </div>
          ) : null}
          <Attachments files={m.attachments} />
          <LinkCard preview={m.linkPreview} />
        </>
      )}

      {m.reactions.length ? (
        <ul className="mt-1 flex flex-wrap gap-1" aria-label="Reactions">
          {m.reactions.map((r) => (
            <li key={r.emoji}>
              <button
                type="button"
                disabled={!o.canPost || busy}
                title={r.names.join(", ")}
                aria-pressed={r.mine}
                onClick={() => void act(() => reactAction({ messageId: m.id, emoji: r.emoji as Reaction }))}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${r.mine ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface"}`}
              >
                <span>{r.emoji}</span>
                <span>{r.count}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {!o.inThread && !m.parentId && m.replyCount > 0 ? (
        <Link href={threadUrl} className="link mt-1 inline-block text-sm font-medium" data-testid="thread-link">
          {m.replyCount === 1 ? "1 reply" : `${m.replyCount} replies`}
          {m.lastReplyAt ? <span className="font-normal text-subtle"> · last {time(m.lastReplyAt, o.timezone)}</span> : null}
        </Link>
      ) : null}

      {note ? (
        <p role={note.error ? "alert" : "status"} className={`notice mt-1 ${note.error ? "notice-error" : "notice-ok"}`}>
          {note.text}{" "}
          {note.url ? (
            <Link className="link" href={note.url}>
              Open
            </Link>
          ) : null}
          <button type="button" className="ml-2 underline" onClick={() => setNote(null)}>
            Dismiss
          </button>
        </p>
      ) : null}

      {!m.deleted ? (
        <div className="absolute right-1 top-0 -translate-y-1/2">
          <button
            type="button"
            aria-label="Message actions"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
            className="rounded-md border border-line bg-surface px-2 py-0.5 text-sm shadow-sm sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
            data-testid="message-actions"
          >
            ⋯
          </button>
          {menu ? (
            <div role="menu" className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-line bg-surface p-1 text-sm shadow-lg" onMouseLeave={() => setMenu(false)}>
              {o.canPost ? (
                <div className="flex flex-wrap gap-0.5 border-b border-line p-1" aria-label="React">
                  {REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      role="menuitem"
                      aria-label={`React ${emoji}`}
                      className="rounded px-1.5 py-1 hover:bg-surface-2"
                      onClick={() => {
                        setMenu(false);
                        void act(() => reactAction({ messageId: m.id, emoji }));
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              ) : null}
              {!o.inThread && !m.parentId ? (
                <Link role="menuitem" href={threadUrl} className="block rounded px-2 py-1.5 hover:bg-surface-2">
                  Reply in thread
                </Link>
              ) : null}
              <MenuButton
                label="Copy link"
                onClick={() => {
                  setMenu(false);
                  const url = `${window.location.origin}${m.parentId ? `${o.base}/${m.channelId}/thread/${m.parentId}` : `${o.base}/${m.channelId}`}?m=${m.id}`;
                  void navigator.clipboard?.writeText(url).then(() => setNote({ text: "Link copied." }));
                }}
              />
              {o.canPost ? (
                <MenuButton
                  label={m.pinned ? "Unpin" : "Pin to this conversation"}
                  onClick={() => {
                    setMenu(false);
                    void act(() => pinAction({ messageId: m.id, pinned: !m.pinned }));
                  }}
                />
              ) : null}
              {mine && o.canPost ? (
                <MenuButton
                  label="Edit"
                  onClick={() => {
                    setMenu(false);
                    setDraft(m.body);
                    setEditing(true);
                  }}
                />
              ) : null}
              {o.crossApps.task ? <CrossApp kind="task" label="Create a task" id={m.id} close={() => setMenu(false)} setNote={setNote} /> : null}
              {o.crossApps.doc ? <CrossApp kind="doc" label="Save to docs" id={m.id} close={() => setMenu(false)} setNote={setNote} /> : null}
              {mine || o.canModerate ? (
                <MenuButton
                  danger
                  label="Delete"
                  onClick={() => {
                    setMenu(false);
                    if (window.confirm(mine ? "Delete this message? Its text and files are removed for everyone." : `Delete ${m.authorName}'s message? This is recorded in the activity log.`)) {
                      void act(() => deleteMessageAction({ messageId: m.id }));
                    }
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function MenuButton({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={`block w-full rounded px-2 py-1.5 text-left hover:bg-surface-2 ${danger ? "text-danger" : ""}`}>
      {label}
    </button>
  );
}

function CrossApp({ kind, label, id, close, setNote }: { kind: "task" | "doc"; label: string; id: string; close: () => void; setNote: (n: { text: string; url?: string; error?: boolean }) => void }) {
  return (
    <MenuButton
      label={label}
      onClick={async () => {
        close();
        const r = await crossAppAction({ messageId: id, kind });
        setNote(r.ok ? { text: r.message, url: r.url } : { text: r.error, error: true });
      }}
    />
  );
}

"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { ChatAttachment } from "../schema";
import { MAX_ATTACHMENTS, MAX_MESSAGE } from "../schemas";
import { mentionQuery, type Person } from "../text";

function newKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The message box: Enter sends, Shift+Enter makes a new line, "@" offers
 * people (and @channel), the paperclip attaches files (uploaded to the
 * suite's file storage first, then sent with the message).
 */
export function Composer({
  placeholder,
  people,
  allowChannelMention,
  canAttach,
  onSend,
}: {
  placeholder: string;
  people: Person[];
  allowChannelMention: boolean;
  canAttach: boolean;
  onSend: (body: string, files: ChatAttachment[], clientKey: string) => Promise<string | null>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [pick, setPick] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const key = useRef(newKey());

  const options = mention
    ? [
        ...people.filter((p) => p.name.toLowerCase().includes(mention.query.toLowerCase())).map((p) => ({ label: p.name, insert: p.name })),
        ...(allowChannelMention && "channel".startsWith(mention.query.toLowerCase()) ? [{ label: "channel (everyone here)", insert: "channel" }] : []),
      ].slice(0, 8)
    : [];

  function updateMention(value: string, caret: number) {
    const q = mentionQuery(value, caret);
    setMention(q);
    setPick(0);
  }

  function choose(insert: string) {
    if (!mention || !area.current) return;
    const caret = area.current.selectionStart;
    const next = `${text.slice(0, mention.start)}@${insert} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    const at = mention.start + insert.length + 2;
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  }

  async function send() {
    const body = text.trim();
    if ((!body && files.length === 0) || sending || uploading) return;
    setSending(true);
    setError(null);
    const problem = await onSend(body, files, key.current);
    setSending(false);
    if (problem) {
      setError(problem);
      return;
    }
    key.current = newKey();
    setText("");
    setFiles([]);
    area.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (options.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPick((p) => (p + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPick((p) => (p - 1 + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(options[pick].insert);
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    const chosen = Array.from(list).slice(0, MAX_ATTACHMENTS - files.length);
    if (chosen.length < list.length) setError(`Attach at most ${MAX_ATTACHMENTS} files to one message.`);
    setUploading((n) => n + chosen.length);
    for (const file of chosen) {
      const form = new FormData();
      form.set("file", file);
      form.set("module", "chat");
      try {
        const res = await fetch("/api/files", { method: "POST", body: form });
        const json = (await res.json()) as { file?: { id: string; name: string; mime: string; size: number }; error?: string };
        if (json.file) setFiles((f) => [...f, { fileId: json.file!.id, name: json.file!.name, mime: json.file!.mime, size: json.file!.size }]);
        else setError(json.error ?? `“${file.name}” could not be uploaded.`);
      } catch {
        setError(`“${file.name}” could not be uploaded: the connection dropped. Try again.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <div className="relative">
      {error ? (
        <p role="alert" className="notice notice-error mb-2">
          {error}
        </p>
      ) : null}
      {options.length ? (
        <ul role="listbox" aria-label="People to mention" className="absolute bottom-full left-0 z-10 mb-1 w-72 max-w-full overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          {options.map((o, i) => (
            <li key={o.insert} role="option" aria-selected={i === pick}>
              <button
                type="button"
                className={`block w-full px-3 py-2 text-left text-sm ${i === pick ? "bg-accent-soft text-accent" : "hover:bg-surface-2"}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o.insert);
                }}
              >
                @{o.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="rounded-lg border border-line bg-surface focus-within:border-accent">
        {files.length || uploading ? (
          <ul className="flex flex-wrap gap-2 px-3 pt-2 text-xs">
            {files.map((f) => (
              <li key={f.fileId} className="badge gap-1">
                <span className="max-w-[12rem] truncate">{f.name}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((x) => x.fileId !== f.fileId))}>
                  ×
                </button>
              </li>
            ))}
            {uploading ? <li className="badge">Uploading…</li> : null}
          </ul>
        ) : null}
        <textarea
          ref={area}
          value={text}
          rows={2}
          maxLength={MAX_MESSAGE}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid="composer"
          className="block max-h-48 min-h-[2.75rem] w-full resize-y bg-transparent px-3 py-2 text-base outline-none sm:text-sm"
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => updateMention(text, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setMention(null), 150)}
        />
        <div className="flex items-center justify-between gap-2 border-t border-line px-2 py-1.5">
          <div className="flex items-center gap-1">
            {canAttach ? (
              <>
                <input ref={fileInput} type="file" multiple className="sr-only" id="chat-attach" onChange={(e) => void upload(e.target.files)} data-testid="attach-input" />
                <label htmlFor="chat-attach" className="btn cursor-pointer px-2.5" title="Attach files (up to 10 MB each)">
                  📎<span className="sr-only">Attach files</span>
                </label>
              </>
            ) : null}
            <span className="hidden text-xs text-subtle sm:inline">Enter to send · Shift+Enter for a new line · @ to mention</span>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={sending || uploading > 0 || (!text.trim() && files.length === 0)}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

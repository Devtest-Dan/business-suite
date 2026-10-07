"use client";

import type { ChatAttachment, ChatLinkPreview } from "../schema";
import { pieces, type Person } from "../text";

export function MessageText({ body, people, viewerId }: { body: string; people: Person[]; viewerId: string }) {
  return (
    <div className="whitespace-pre-wrap break-words leading-relaxed" data-testid="message-text">
      {pieces(body, people, viewerId).map((p, i) => {
        if (p.type === "link")
          return (
            <a key={i} href={p.href} className="link break-all" target="_blank" rel="noopener noreferrer nofollow">
              {p.text}
            </a>
          );
        if (p.type === "mention")
          return (
            <span key={i} className={`rounded px-0.5 font-medium ${p.me ? "text-warn" : "bg-accent-soft text-accent"}`} style={p.me ? { background: "var(--warn-soft)" } : undefined}>
              {p.text}
            </span>
          );
        if (p.type === "code")
          return (
            <code key={i} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]">
              {p.text}
            </code>
          );
        return <span key={i}>{p.text}</span>;
      })}
    </div>
  );
}

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Attachments({ files }: { files: ChatAttachment[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-2">
      {files.map((f) => {
        const url = `/api/files/${f.fileId}`;
        const image = f.mime.startsWith("image/") && f.mime !== "image/svg+xml";
        return (
          <li key={f.fileId}>
            {image ? (
              <a href={url} target="_blank" rel="noopener noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element -- files are served by the suite itself, behind sign-in */}
                <img src={url} alt={f.name} loading="lazy" className="max-h-60 max-w-full rounded-lg border border-line object-contain sm:max-w-sm" />
              </a>
            ) : (
              <a href={url} className="card flex items-center gap-2 !p-2.5 text-sm" download={f.name}>
                <span aria-hidden>📄</span>
                <span className="max-w-[14rem] truncate font-medium">{f.name}</span>
                <span className="text-xs text-subtle">{size(f.size)}</span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function LinkCard({ preview }: { preview: ChatLinkPreview | null }) {
  if (!preview) return null;
  return (
    <a href={preview.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-1.5 block max-w-md rounded-lg border-l-4 border-line bg-surface-2 px-3 py-2 text-sm" style={{ borderLeftColor: "var(--accent)" }}>
      <span className="block text-xs text-subtle">{preview.siteName || preview.host}</span>
      <span className="block font-medium">{preview.title}</span>
      {preview.description ? <span className="muted line-clamp-2 block">{preview.description}</span> : null}
    </a>
  );
}

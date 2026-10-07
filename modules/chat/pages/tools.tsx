import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import type { ModulePageProps } from "@/lib/modules/contract";
import { importSlackAction, previewHostsAction } from "../actions";
import { isDirect, messageUrl, previewHosts, searchMessages } from "../data";
import { ChatFrame } from "./frame";

function Snippet({ text }: { text: string }) {
  // ts_headline marks matches with « »; draw them bold without trusting any HTML.
  return (
    <>
      {text.split(/(«[^»]*»)/g).map((part, i) =>
        part.startsWith("«") && part.endsWith("»") ? (
          <mark key={i} className="rounded bg-accent-soft px-0.5 text-accent">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export async function SearchPage({ ctx, basePath, searchParams }: ModulePageProps) {
  const q = typeof searchParams.q === "string" ? searchParams.q.trim().slice(0, 200) : "";
  const hits = q.length >= 2 ? await searchMessages(ctx.db, ctx.viewer, q, 50) : [];
  return (
    <ChatFrame ctx={ctx} basePath={basePath}>
      <div className="space-y-6">
        <header>
          <h1 className="h1">Search messages</h1>
          <p className="muted">Searches every conversation you can read, including archived channels. Use quotes for an exact phrase, a minus to leave a word out.</p>
        </header>
        <form className="flex gap-2" action={`${basePath}/search`}>
          <input name="q" defaultValue={q} className="input" aria-label="Search messages" placeholder="invoice friday" minLength={2} />
          <button type="submit" className="btn btn-primary">
            Search
          </button>
        </form>
        {q.length >= 2 ? (
          hits.length ? (
            <ul className="space-y-2" data-testid="chat-search-results">
              {hits.map((h) => (
                <li key={h.id}>
                  <Link href={messageUrl(h)} className="card card-link block space-y-1">
                    <p className="text-xs text-subtle">
                      {isDirect(h.channelKind) ? "Direct message" : `#${h.channelName}`}
                      {h.parentId ? " · in a thread" : ""} · {h.authorName} · {formatDateTime(h.createdAt, ctx.business.timezone)}
                    </p>
                    <p className="text-sm">
                      <Snippet text={h.snippet} />
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="card muted">No messages match “{q}”.</p>
          )
        ) : null}
      </div>
    </ChatFrame>
  );
}

export function ImportPage({ ctx, basePath }: ModulePageProps) {
  return (
    <ChatFrame ctx={ctx} basePath={basePath}>
      <div className="max-w-2xl space-y-6">
        <header>
          <h1 className="h1">Import from Slack</h1>
          <p className="muted">
            Bring your Slack history with you. In Slack, a workspace owner or admin uses <strong>Settings → Import/Export data → Export</strong> and downloads the ZIP. Upload it here unchanged.
          </p>
        </header>
        <section className="card space-y-2 text-sm">
          <h2 className="h2">What comes across</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>Public channels (and private ones, if your Slack plan included them in the export), with their topics and archived state.</li>
            <li>Messages and threads, with their original times. People are matched to accounts here by email address; anyone without an account keeps their Slack name.</li>
            <li>Not imported: direct messages, reactions, and the files themselves (Slack&apos;s file links need a Slack login). A message says which file was attached.</li>
          </ul>
          <p>
            Nothing is written until someone approves it in <Link className="link" href="/approvals">Approvals</Link>. Each approval holds up to 1,000 messages; importing the same export again never makes duplicates.
          </p>
        </section>
        <ActionForm action={importSlackAction} submit="Read the export and send for approval" className="card space-y-4">
          <label className="block">
            <span className="label">Slack export (.zip, up to 12 MB)</span>
            <input type="file" name="file" accept=".zip,application/zip" required className="input" />
          </label>
        </ActionForm>
      </div>
    </ChatFrame>
  );
}

export async function AdminPage({ ctx, basePath }: ModulePageProps) {
  const hosts = await previewHosts(ctx.db);
  return (
    <ChatFrame ctx={ctx} basePath={basePath}>
      <div className="max-w-2xl space-y-6">
        <header>
          <h1 className="h1">Chat settings</h1>
        </header>
        <section className="card space-y-3">
          <h2 className="h2">Link previews</h2>
          <p className="muted text-sm">
            Off unless you list sites here. For a link to a listed site, the server reads that page&apos;s title and short description (text only, no images) and shows them under the message. Links to any
            other site are never fetched. List only sites you trust, one per line, e.g. <code>docs.google.com</code>.
          </p>
          <ActionForm action={previewHostsAction} submit="Save">
            <label className="block">
              <span className="label">Sites allowed to show a preview</span>
              <textarea name="hosts" rows={6} className="input font-mono text-sm" defaultValue={hosts.join("\n")} />
              <span className="hint">Leave empty to switch previews off.</span>
            </label>
          </ActionForm>
        </section>
      </div>
    </ChatFrame>
  );
}

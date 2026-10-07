import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { addMembersAction, archiveAction, createChannelAction, joinAction, leaveAction, notifyAction, openDmAction, removeMemberAction, renameAction, topicAction } from "../actions";
import { browseChannels, channelMembers, conversationLabel, getAccess, isDirect, P, pinnedMessages, visiblePeople } from "../data";
import { ChatFrame } from "./frame";
import { MessageText } from "../components/message-body";
import { formatDateTime } from "@/lib/format";

const uuid = z.string().uuid();

export function NewChannelPage({ ctx, basePath }: ModulePageProps) {
  return (
    <ChatFrame ctx={ctx} basePath={basePath}>
      <div className="max-w-xl space-y-6">
        <header>
          <h1 className="h1">New channel</h1>
          <p className="muted">A channel is for a topic, a team or a project. Anyone except guests can find and join a public channel; a private one is only for the people you add.</p>
        </header>
        {ctx.viewer.role === "guest" ? (
          <p className="notice notice-warn">Guests cannot create channels.</p>
        ) : (
          <ActionForm action={createChannelAction} submit="Create channel" className="card space-y-4">
            <label className="block">
              <span className="label">Name</span>
              <input name="name" required maxLength={60} className="input" placeholder="front-desk" />
              <span className="hint">Lower-case; spaces become dashes.</span>
            </label>
            <label className="block">
              <span className="label">Topic (optional)</span>
              <input name="topic" maxLength={250} className="input" placeholder="What this channel is for" />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="private" className="size-4" />
              <span>Private: only people who are added can see it</span>
            </label>
          </ActionForm>
        )}
      </div>
    </ChatFrame>
  );
}

export async function BrowsePage({ ctx, basePath }: ModulePageProps) {
  const all = await browseChannels(ctx.db, ctx.viewer);
  const open = all.filter((c) => !c.archived);
  const archived = all.filter((c) => c.archived);
  return (
    <ChatFrame ctx={ctx} basePath={basePath}>
      <div className="space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="h1">Browse channels</h1>
            <p className="muted">Public channels anyone on the team can join, and the private ones you are in.</p>
          </div>
          {ctx.can(P.create) && ctx.viewer.role !== "guest" ? (
            <Link href={`${basePath}/new`} className="btn btn-primary">
              New channel
            </Link>
          ) : null}
        </header>
        <ul className="space-y-2" data-testid="channel-directory">
          {open.map((c) => (
            <li key={c.id} className="card flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <Link href={`${basePath}/${c.id}`} className="font-semibold hover:underline">
                  {c.kind === "private" ? "🔒 " : "#"}
                  {c.name}
                </Link>
                <p className="muted text-sm">
                  {c.members === 1 ? "1 person" : `${c.members} people`}
                  {c.topic ? ` · ${c.topic}` : ""}
                </p>
              </div>
              {c.joined ? (
                <span className="badge badge-ok">Joined</span>
              ) : (
                <form action={joinAction.bind(null, c.id)}>
                  <button type="submit" className="btn">
                    Join
                  </button>
                </form>
              )}
            </li>
          ))}
          {open.length === 0 ? <li className="card muted">No channels yet.</li> : null}
        </ul>
        {archived.length ? (
          <section className="space-y-2">
            <h2 className="h2">Archived</h2>
            <p className="muted text-sm">Read-only. Their messages still show up in search.</p>
            <ul className="space-y-1">
              {archived.map((c) => (
                <li key={c.id}>
                  <Link href={`${basePath}/${c.id}`} className="link">
                    #{c.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </ChatFrame>
  );
}

export async function DirectPage({ ctx, basePath }: ModulePageProps) {
  const people = (await visiblePeople(ctx.db, ctx.viewer)).filter((p) => p.id !== ctx.viewer.id);
  return (
    <ChatFrame ctx={ctx} basePath={basePath}>
      <div className="max-w-xl space-y-6">
        <header>
          <h1 className="h1">New message</h1>
          <p className="muted">Pick one person for a direct message, or up to eight for a small group. The same people always land in the same conversation.</p>
        </header>
        {people.length === 0 ? (
          <p className="card muted">{ctx.viewer.role === "guest" ? "You can message people you share a channel with. Nobody yet." : "Nobody else has an account yet. Invite your team from People."}</p>
        ) : (
          <ActionForm action={openDmAction} submit="Open conversation" className="card space-y-3">
            <fieldset className="max-h-96 space-y-1 overflow-y-auto" data-testid="dm-people">
              <legend className="label">People</legend>
              {people.map((p) => (
                <label key={p.id} className="flex min-h-9 items-center gap-2 rounded px-1 hover:bg-surface-2">
                  <input type="checkbox" name="user" value={p.id} className="size-4" />
                  <span>{p.name}</span>
                  {p.role === "guest" ? <span className="badge">guest</span> : null}
                </label>
              ))}
            </fieldset>
          </ActionForm>
        )}
      </div>
    </ChatFrame>
  );
}

export async function DetailsPage({ ctx, params, basePath }: ModulePageProps) {
  const id = uuid.safeParse(params.channelId);
  if (!id.success) notFound();
  const access = await getAccess(ctx, id.data);
  if (!access) notFound();
  const c = access.channel;
  const [members, label, everyone] = await Promise.all([channelMembers(ctx.db, c.id), conversationLabel(ctx.db, c, ctx.viewer.id), visiblePeople(ctx.db, ctx.viewer)]);
  const inIt = new Set(members.map((m) => m.id));
  const addable = everyone.filter((p) => !inIt.has(p.id) && (p.role !== "guest" || ctx.can(P.manage)));
  const direct = isDirect(c.kind);
  const back = `${basePath}/${c.id}`;
  return (
    <ChatFrame ctx={ctx} basePath={basePath} currentId={c.id}>
      <div className="max-w-2xl space-y-6">
        <header>
          <Link href={back} className="link text-sm">
            ← {label}
          </Link>
          <h1 className="h1">{direct ? "Conversation settings" : `About ${label}`}</h1>
        </header>

        {access.member ? (
          <section className="card space-y-3">
            <h2 className="h2">Notifications</h2>
            <ActionForm action={notifyAction} submit="Save">
              <input type="hidden" name="channelId" value={c.id} />
              <fieldset className="space-y-1">
                {[
                  ["all", "Every new message"],
                  ["mentions", direct ? "Every new message (direct messages always count as mentions)" : "Only when someone mentions me or @channel"],
                  ["none", "Nothing (it still shows as unread)"],
                ].map(([value, text]) => (
                  <label key={value} className="flex items-center gap-2">
                    <input type="radio" name="notify" value={value} defaultChecked={access.member?.notify === value} className="size-4" />
                    <span>{text}</span>
                  </label>
                ))}
              </fieldset>
              <p className="hint">Whether these also reach your phone is set in <Link className="link" href="/account#push">Account → Push notifications</Link>.</p>
            </ActionForm>
          </section>
        ) : null}

        {!direct && access.member && !c.archivedAt ? (
          <section className="card space-y-3">
            <h2 className="h2">Topic</h2>
            <ActionForm action={topicAction} submit="Save topic">
              <input type="hidden" name="channelId" value={c.id} />
              <input name="topic" defaultValue={c.topic} maxLength={250} className="input" aria-label="Topic" />
            </ActionForm>
          </section>
        ) : null}

        {access.canManage && !c.archivedAt ? (
          <section className="card space-y-3">
            <h2 className="h2">Name</h2>
            <ActionForm action={renameAction} submit="Rename">
              <input type="hidden" name="channelId" value={c.id} />
              <input name="name" defaultValue={c.name ?? ""} maxLength={60} className="input" aria-label="Channel name" />
            </ActionForm>
          </section>
        ) : null}

        <section className="card space-y-3">
          <h2 className="h2">People ({members.length})</h2>
          <ul className="divide-y divide-[var(--line)]" data-testid="channel-members">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
                <span>
                  {m.name}
                  {m.role === "guest" ? <span className="badge ml-2">guest</span> : null}
                  {m.id === c.createdBy && !direct ? <span className="badge ml-2">made it</span> : null}
                </span>
                {access.canManage && m.id !== ctx.viewer.id ? (
                  <form action={removeMemberAction.bind(null, { channelId: c.id, userId: m.id })}>
                    <button type="submit" className="btn btn-danger text-xs">
                      Remove
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          {!direct && !c.archivedAt && (access.member || ctx.can(P.manage)) && addable.length ? (
            <ActionForm action={addMembersAction} submit="Add to channel" resetOnSuccess>
              <input type="hidden" name="channelId" value={c.id} />
              <fieldset className="max-h-64 space-y-1 overflow-y-auto">
                <legend className="label">Add people</legend>
                {addable.map((p) => (
                  <label key={p.id} className="flex items-center gap-2">
                    <input type="checkbox" name="user" value={p.id} className="size-4" />
                    <span>{p.name}</span>
                    {p.role === "guest" ? <span className="badge">guest: sees only the channels they are added to</span> : null}
                  </label>
                ))}
              </fieldset>
            </ActionForm>
          ) : null}
        </section>

        {!direct ? (
          <section className="card flex flex-wrap gap-2">
            {access.member ? (
              <form action={leaveAction.bind(null, c.id)}>
                <button type="submit" className="btn">
                  Leave channel
                </button>
              </form>
            ) : null}
            {access.canManage ? (
              <form action={archiveAction.bind(null, c.id, !c.archivedAt)}>
                <button type="submit" className="btn btn-danger" disabled={!c.archivedAt && c.isDefault} title={c.isDefault ? "The channel everyone joins first cannot be archived." : undefined}>
                  {c.archivedAt ? "Unarchive channel" : "Archive channel"}
                </button>
              </form>
            ) : null}
          </section>
        ) : null}
      </div>
    </ChatFrame>
  );
}

export async function PinsPage({ ctx, params, basePath }: ModulePageProps) {
  const id = uuid.safeParse(params.channelId);
  if (!id.success) notFound();
  const access = await getAccess(ctx, id.data);
  if (!access) notFound();
  const [pins, label] = await Promise.all([pinnedMessages(ctx.db, ctx.viewer, access.channel.id), conversationLabel(ctx.db, access.channel, ctx.viewer.id)]);
  return (
    <ChatFrame ctx={ctx} basePath={basePath} currentId={access.channel.id}>
      <div className="max-w-2xl space-y-6">
        <header>
          <Link href={`${basePath}/${access.channel.id}`} className="link text-sm">
            ← {label}
          </Link>
          <h1 className="h1">Pinned in {label}</h1>
        </header>
        {pins.length === 0 ? (
          <p className="card muted">Nothing is pinned. Use a message&apos;s ⋯ menu to pin it here.</p>
        ) : (
          <ul className="space-y-2" data-testid="pinned-list">
            {pins.map((m) => (
              <li key={m.id} className="card space-y-1">
                <p className="text-sm text-subtle">
                  {m.authorName} · {formatDateTime(m.createdAt, ctx.business.timezone)}
                </p>
                <MessageText body={m.body} people={[]} viewerId={ctx.viewer.id} />
                <Link className="link text-sm" href={m.parentId ? `${basePath}/${m.channelId}/thread/${m.parentId}?m=${m.id}` : `${basePath}/${m.channelId}?m=${m.id}`}>
                  Show in conversation
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ChatFrame>
  );
}

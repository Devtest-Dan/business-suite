import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import type { ModulePageProps } from "@/lib/modules/contract";
import { enabledModules } from "@/lib/modules/registry-access";
import { archiveAction, joinAction } from "../actions";
import { Conversation } from "../components/conversation";
import { SummariseForm } from "../components/summarise-form";
import { ensureDefaultMemberships } from "../channels";
import { findTarget } from "../cross-app";
import { channelMembers, channelReaders, conversationLabel, getAccess, isDirect, listMessages, messageRow, P, unreadIn, type Access } from "../data";
import { ChatFrame } from "./frame";

const uuid = z.string().uuid();

function kindLabel(a: Access): string {
  switch (a.channel.kind) {
    case "public":
      return "Public channel";
    case "private":
      return "Private channel";
    case "group":
      return "Group conversation";
    default:
      return "Direct message";
  }
}

async function load(props: ModulePageProps, threadId: string | null) {
  const { ctx, params, searchParams } = props;
  const id = uuid.safeParse(params.channelId);
  if (!id.success) notFound();
  await ensureDefaultMemberships(ctx);
  const access = await getAccess(ctx, id.data);
  if (!access) notFound();
  const lastRead = access.member?.lastReadCseq ?? Number.MAX_SAFE_INTEGER;
  const unread = access.member && !threadId ? await unreadIn(ctx.db, ctx.viewer.id, access.channel.id, lastRead) : 0;
  const [page, readers, members, label, modules] = await Promise.all([
    listMessages(ctx.db, ctx.viewer, access.channel.id, { parentId: threadId, limit: Math.min(300, Math.max(50, unread + 15)) }),
    channelReaders(ctx.db, access.channel),
    channelMembers(ctx.db, access.channel.id),
    conversationLabel(ctx.db, access.channel, ctx.viewer.id),
    enabledModules(),
  ]);
  const highlight = typeof searchParams.m === "string" && uuid.safeParse(searchParams.m).success ? searchParams.m : null;
  return { access, page, readers, members, label, unread, highlight, crossApps: { task: Boolean(findTarget("task", modules)), doc: Boolean(findTarget("doc", modules)) } };
}

export async function ChannelPage(props: ModulePageProps) {
  return <ConversationPage {...props} threadId={null} />;
}

export async function ThreadPage(props: ModulePageProps) {
  const id = uuid.safeParse(props.params.messageId);
  if (!id.success) notFound();
  const root = await messageRow(props.ctx.db, id.data);
  if (!root || root.channelId !== props.params.channelId) notFound();
  // A link to a reply opens its thread.
  if (root.parentId) redirect(`${props.basePath}/${root.channelId}/thread/${root.parentId}?m=${root.id}`);
  return <ConversationPage {...props} threadId={id.data} />;
}

async function ConversationPage(props: ModulePageProps & { threadId: string | null }) {
  const { ctx, basePath, threadId } = props;
  const d = await load(props, threadId);
  const { access } = d;
  const c = access.channel;
  const base = `${basePath}/${c.id}`;
  const guest = ctx.viewer.role === "guest";

  let blocked: ReactNode = null;
  if (c.archivedAt) {
    blocked = (
      <div className="notice notice-warn flex flex-wrap items-center justify-between gap-2" data-testid="archived-notice">
        <span>This channel is archived. You can read and search it, but nobody can post.</span>
        {access.canManage ? (
          <form action={archiveAction.bind(null, c.id, false)}>
            <button className="btn" type="submit">
              Unarchive
            </button>
          </form>
        ) : null}
      </div>
    );
  } else if (!access.member) {
    blocked = access.canJoin ? (
      <form action={joinAction.bind(null, c.id)} className="card flex flex-wrap items-center justify-between gap-2">
        <span>You are reading #{c.name}. Join to post and get its notifications.</span>
        <button className="btn btn-primary" type="submit">
          Join #{c.name}
        </button>
      </form>
    ) : (
      <p className="notice notice-warn">You are not in this conversation.</p>
    );
  } else if (!ctx.can(P.post)) {
    blocked = <p className="notice notice-warn">Your role can read chat but not post. Ask the owner if you need to post.</p>;
  }

  return (
    <ChatFrame ctx={ctx} basePath={basePath} currentId={c.id}>
      <div className="flex h-[calc(100dvh-9.5rem)] flex-col lg:h-[calc(100dvh-5rem)]">
        <header className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
          <div className="min-w-0">
            {threadId ? (
              <>
                <Link href={base} className="link text-sm">
                  ← {d.label}
                </Link>
                <h1 className="h1">Thread</h1>
              </>
            ) : (
              <>
                <h1 className="h1 truncate" data-testid="conversation-title">
                  {d.label}
                </h1>
                <p className="text-sm text-subtle">
                  {kindLabel(access)}
                  {c.archivedAt ? " · archived" : ""} · {d.members.length === 1 ? "1 person" : `${d.members.length} people`}
                  {c.topic ? (
                    <>
                      {" · "}
                      <span className="text-fg" data-testid="channel-topic">
                        {c.topic}
                      </span>
                    </>
                  ) : null}
                </p>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-start gap-2">
            {ctx.can("assistant.use") && access.member ? <SummariseForm channelId={c.id} parentId={threadId} hasUnread={d.unread > 0} /> : null}
            {!threadId ? (
              <>
                <Link href={`${base}/pins`} className="btn">
                  Pinned
                </Link>
                {access.member || access.canManage ? (
                  <Link href={`${base}/details`} className="btn">
                    {isDirect(c.kind) ? "Settings" : "Details"}
                  </Link>
                ) : null}
              </>
            ) : null}
          </div>
        </header>
        <Conversation
          key={`${c.id}:${threadId ?? ""}`}
          channelId={c.id}
          parentId={threadId}
          initial={d.page.messages}
          more={d.page.more}
          lastReadCseq={threadId ? Number.MAX_SAFE_INTEGER : (access.member?.lastReadCseq ?? Number.MAX_SAFE_INTEGER)}
          highlightId={d.highlight}
          viewerId={ctx.viewer.id}
          people={d.readers}
          timezone={ctx.business.timezone}
          canPost={access.canPost}
          canModerate={ctx.can(P.manage)}
          crossApps={guest ? { task: false, doc: false } : d.crossApps}
          base={basePath}
          placeholder={threadId ? "Reply in the thread" : `Message ${d.label}`}
          allowChannelMention={ctx.can(P.mentionAll) && !isDirect(c.kind)}
          canAttach={ctx.can("files.upload")}
          blocked={blocked}
        />
      </div>
    </ChatFrame>
  );
}

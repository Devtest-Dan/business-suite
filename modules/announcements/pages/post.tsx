import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime } from "@/lib/format";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { enabledModules } from "@/lib/modules/registry-access";
import { togglePin } from "../actions";
import { getPost, P, receipts } from "../data";
import { postIdSchema } from "../schemas";
import { MarkRead } from "./mark-read";

export async function PostPage({ ctx, params, basePath }: ModulePageProps) {
  const id = postIdSchema.safeParse(params.postId);
  if (!id.success) notFound();
  const post = await getPost(ctx, id.data);
  if (!post) notFound();
  const seen = ctx.can(P.receipts) ? await receipts(ctx, post.id) : null;
  const tz = ctx.business.timezone;
  // Cross-app link: only when the Assistant app is switched on and the person may add facts.
  const canRemember = ctx.can("assistant.remember") && (await enabledModules()).some((m) => m.id === "assistant");
  const rememberHref = `/m/assistant/remember?${new URLSearchParams({ text: `${post.title}: ${post.body}`.slice(0, 2000), from: `Announcements: ${post.title}`.slice(0, 300), url: `${basePath}/${post.id}` })}`;

  return (
    <article className="max-w-2xl space-y-6">
      {!post.readAt ? <MarkRead postId={post.id} /> : null}
      <header className="space-y-1">
        <Link href={basePath} className="link text-sm">
          ← Announcements
        </Link>
        <h1 className="h1 flex items-center gap-2">
          {post.pinned ? <Icon name="pin" className="size-5 text-accent" label="Pinned" /> : null}
          {post.title}
        </h1>
        <p className="text-sm text-subtle">
          {post.authorName} · {formatDateTime(post.createdAt, tz)}
        </p>
      </header>
      <div className="card whitespace-pre-line leading-relaxed" data-testid="announcement-body">
        {post.body}
      </div>
      {ctx.can(P.pin) || canRemember ? (
        <div className="flex flex-wrap gap-2">
          {ctx.can(P.pin) ? (
            <form action={togglePin.bind(null, post.id, !post.pinned)}>
              <button className="btn" type="submit">
                <Icon name="pin" className="size-4" /> {post.pinned ? "Unpin" : "Pin to the top"}
              </button>
            </form>
          ) : null}
          {canRemember ? (
            <Link className="btn" href={rememberHref}>
              <Icon name="sparkles" className="size-4" /> Remember this
            </Link>
          ) : null}
        </div>
      ) : null}
      {seen ? (
        <section className="card space-y-3" aria-labelledby="receipts">
          <h2 id="receipts" className="h2">
            Read by {seen.read.length} of {seen.read.length + seen.unread.length}
          </h2>
          {seen.read.length ? (
            <ul className="space-y-1 text-sm" data-testid="read-receipts">
              {seen.read.map((r) => (
                <li key={r.name + r.at.toISOString()} className="flex justify-between gap-3">
                  <span>{r.name}</span>
                  <span className="text-subtle">{formatDateTime(r.at, tz)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {seen.unread.length ? <p className="muted text-sm">Not read yet: {seen.unread.join(", ")}</p> : null}
        </section>
      ) : null}
    </article>
  );
}

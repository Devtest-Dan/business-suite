import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { listPosts, P } from "../data";

export async function ListPage({ ctx, basePath }: ModulePageProps) {
  const posts = await listPosts(ctx);
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Announcements</h1>
          <p className="muted">News for everyone in {ctx.business.name}. Pinned posts stay at the top.</p>
        </div>
        <div className="flex gap-2">
          {ctx.can(P.import) ? (
            <Link href={`${basePath}/import`} className="btn">
              Import
            </Link>
          ) : null}
          {ctx.can(P.post) ? (
            <Link href={`${basePath}/new`} className="btn btn-primary">
              <Icon name="plus" className="size-4" /> New announcement
            </Link>
          ) : null}
        </div>
      </header>

      {posts.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">No announcements yet.</p>
          <p className="muted">{ctx.can(P.post) ? "Post the first one with “New announcement”." : "When someone posts one, it shows up here."}</p>
        </div>
      ) : (
        <ul className="space-y-3" data-testid="announcement-list">
          {posts.map((post) => (
            <li key={post.id}>
              <Link href={`${basePath}/${post.id}`} className="card card-link block">
                <div className="flex items-start gap-3">
                  {post.pinned ? <Icon name="pin" className="mt-0.5 size-4 shrink-0 text-accent" label="Pinned" /> : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <h2 className="font-semibold">{post.title}</h2>
                      {!post.readAt ? <span className="badge badge-accent">Unread</span> : null}
                    </div>
                    <p className="muted line-clamp-2 whitespace-pre-line">{post.body}</p>
                    <p className="mt-1 text-xs text-subtle">
                      {post.authorName} · {formatDateTime(post.createdAt, ctx.business.timezone)}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import Link from "next/link";
import { z } from "zod";
import { defineAction, defineModule, defineReadTool } from "@/lib/modules/contract";
import { createPost, listPosts, MODULE_ID, P, searchPosts, unreadCount, unreadPosts } from "./data";
import { ImportPage } from "./pages/import";
import { ListPage } from "./pages/list";
import { NewPage } from "./pages/new";
import { PostPage } from "./pages/post";
import { announcementInput, type AnnouncementInput } from "./schemas";

/** Announcements: post news to everyone, pin what matters, see who has read it. */
export const announcements = defineModule({
  id: MODULE_ID,
  name: "Announcements",
  description: "Post news to the whole team, pin what matters, and see who has read it.",
  version: "1.0.0",
  icon: "megaphone",
  nav: [{ label: "Announcements", path: "", icon: "megaphone" }],
  permissions: [
    { key: P.access, label: "See announcements", description: "Read announcements and get notified of new ones.", defaultRoles: ["owner", "admin", "member", "guest"] },
    { key: P.post, label: "Post announcements", description: "Write and post a new announcement.", defaultRoles: ["owner", "admin"] },
    { key: P.pin, label: "Pin announcements", description: "Pin and unpin announcements.", defaultRoles: ["owner", "admin"] },
    { key: P.receipts, label: "See read receipts", description: "See who has and has not read each announcement.", defaultRoles: ["owner", "admin"] },
    { key: P.import, label: "Import announcements", description: "Paste a CSV of announcements to send for approval.", defaultRoles: ["owner", "admin"] },
  ],
  routes: [
    { path: "", title: "Announcements", permission: P.access, page: ListPage },
    { path: "new", title: "New announcement", permission: P.post, page: NewPage },
    { path: "import", title: "Import announcements", permission: P.import, page: ImportPage },
    { path: ":postId", title: "Announcement", permission: P.access, page: PostPage },
  ],
  migrations: { folder: "modules/announcements/migrations" },
  search: { label: "Announcements", permission: P.access, search: searchPosts },
  notifications: [{ kind: "announcements.posted", label: "A new announcement is posted", pushByDefault: true }],
  widget: {
    title: "Announcements",
    permission: P.access,
    render: async (ctx) => {
      const [posts, unread] = await Promise.all([listPosts(ctx, 3), unreadCount(ctx)]);
      if (posts.length === 0) return <p className="muted text-sm">No announcements yet.</p>;
      return (
        <div className="space-y-2">
          {unread ? <p className="text-sm font-medium">{unread} unread</p> : null}
          <ul className="space-y-1 text-sm">
            {posts.map((p) => (
              <li key={p.id} className="truncate">
                <Link className="link" href={`/m/${MODULE_ID}/${p.id}`}>
                  {p.pinned ? "Pinned: " : ""}
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      );
    },
  },
  needsMe: async (ctx) => {
    if (!ctx.can(P.access)) return [];
    const unread = await unreadPosts(ctx, 5);
    return unread.map((p) => ({ title: `Read: ${p.title}`, detail: "New announcement", url: `/m/${MODULE_ID}/${p.id}` }));
  },
  actions: [
    defineAction<AnnouncementInput>({
      name: "post",
      label: "Post an announcement",
      permission: P.post,
      input: announcementInput,
      preview: (a) => `Post “${a.title}”${a.pinned ? " (pinned)" : ""}: ${a.body.slice(0, 120)}${a.body.length > 120 ? "…" : ""}`,
      sideEffects: "database",
      apply: async (ctx, input) => {
        const author = ctx.requestedBy ?? ctx.approver;
        const { post, announce } = await createPost(ctx.tx, input, author, { sourceKey: `${ctx.approvalId}:${ctx.dedupeKey}`, via: ctx.source });
        return { targetId: post.id, summary: `Posted “${post.title}”`, after: announce };
      },
    }),
  ],
  aiTools: [
    defineReadTool<{ limit: number }>({
      name: "list_announcements",
      description: "List the most recent announcements (pinned first) with their title, author, date and text.",
      permission: P.access,
      input: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
      run: async (ctx, { limit }) =>
        (await listPosts(ctx, limit)).map((p) => ({ id: p.id, title: p.title, author: p.authorName, pinned: p.pinned, postedAt: p.createdAt.toISOString(), body: p.body })),
    }),
    defineReadTool<{ query: string }>({
      name: "search_announcements",
      description: "Full-text search of announcements.",
      permission: P.access,
      input: z.object({ query: z.string().min(1).max(200) }),
      run: async (ctx, { query }) => searchPosts(ctx, query, 10),
    }),
    { kind: "write", name: "post_announcement", description: "Draft one announcement. It is held for a person to approve before anyone sees it.", action: "post" },
    { kind: "write", name: "post_announcements", description: "Draft several announcements as one batch. The whole batch is held as one approval.", action: "post", batch: true },
  ],
  seed: async (ctx) => {
    // Seeding runs while the owner is the only person, so there is no one to notify.
    await createPost(
      ctx.db,
      {
        title: `Welcome to ${ctx.business.name}'s suite`,
        body: "This is where the team's news goes. Admins can post and pin announcements; everyone sees who has read what.\n\nOpen Settings to add your logo, then invite your team from People.",
        pinned: true,
      },
      ctx.viewer,
    );
  },
});

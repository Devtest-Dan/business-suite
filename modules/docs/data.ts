import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import type { Db, DbTx } from "@/lib/db/client";
import { files, users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { ModuleContext, SearchHit, Viewer } from "@/lib/modules/contract";
import { permissionsFor } from "@/lib/permissions";
import { deleteStoredFile } from "@/lib/storage";
import { accessFor, canEdit, canManage, canRead, MODULE_ID, P, type Access, type SpaceRole, type Who } from "./access";
import { extractLinks, plainText } from "./markdown";
import { docsAttachments, docsLinks, docsPages, docsRevisions, docsSpaceMembers, docsSpaces, type ProcedureStep } from "./schema";
import type { PageFields } from "./schemas";

export { MODULE_ID, P };

type Conn = Db | DbTx;
export type Space = typeof docsSpaces.$inferSelect;
export type SpaceWithAccess = Space & { access: Access; memberRole: SpaceRole | null };
export type Page = Omit<typeof docsPages.$inferSelect, "search">;
export type Revision = typeof docsRevisions.$inferSelect;
export type Via = "user" | "ai" | "import" | "restore";

const pageColumns = {
  id: docsPages.id,
  spaceId: docsPages.spaceId,
  parentId: docsPages.parentId,
  title: docsPages.title,
  body: docsPages.body,
  kind: docsPages.kind,
  steps: docsPages.steps,
  schedule: docsPages.schedule,
  scheduleDay: docsPages.scheduleDay,
  isTemplate: docsPages.isTemplate,
  revision: docsPages.revision,
  createdBy: docsPages.createdBy,
  updatedBy: docsPages.updatedBy,
  updatedByName: docsPages.updatedByName,
  createdAt: docsPages.createdAt,
  updatedAt: docsPages.updatedAt,
  archivedAt: docsPages.archivedAt,
  importPath: docsPages.importPath,
  sourceKey: docsPages.sourceKey,
};

/** A ModuleContext's permission check, for a person who is not the one viewing (an approver, an assignee). */
export async function whoFor(viewer: Pick<Viewer, "id" | "role">): Promise<Who> {
  const held = await permissionsFor(viewer.role);
  return { viewer, can: (p) => held.has(p) };
}

// ── Spaces ───────────────────────────────────────────────────────────────────

/** Every space the person can read (archived ones too when asked), with their access. */
export async function spacesFor(conn: Conn, who: Who, options: { archived?: boolean } = {}): Promise<SpaceWithAccess[]> {
  const rows = await conn
    .select({ space: docsSpaces, memberRole: docsSpaceMembers.role })
    .from(docsSpaces)
    .leftJoin(docsSpaceMembers, and(eq(docsSpaceMembers.spaceId, docsSpaces.id), eq(docsSpaceMembers.userId, who.viewer.id)))
    .where(options.archived ? undefined : isNull(docsSpaces.archivedAt))
    .orderBy(asc(docsSpaces.name));
  return rows
    .map((r) => ({ ...r.space, memberRole: r.memberRole, access: accessFor(who, r.space, r.memberRole) }))
    .filter((s) => canRead(s.access));
}

export async function readableSpaceIds(conn: Conn, who: Who): Promise<string[]> {
  return (await spacesFor(conn, who)).map((s) => s.id);
}

export async function getSpace(conn: Conn, who: Who, id: string): Promise<SpaceWithAccess | null> {
  const [row] = await conn
    .select({ space: docsSpaces, memberRole: docsSpaceMembers.role })
    .from(docsSpaces)
    .leftJoin(docsSpaceMembers, and(eq(docsSpaceMembers.spaceId, docsSpaces.id), eq(docsSpaceMembers.userId, who.viewer.id)))
    .where(eq(docsSpaces.id, id));
  if (!row) return null;
  const access = accessFor(who, row.space, row.memberRole);
  return canRead(access) ? { ...row.space, memberRole: row.memberRole, access } : null;
}

/** The space other apps and the AI write to when they do not name one: the oldest team space. */
export async function defaultSpace(conn: Conn): Promise<Space | null> {
  const [row] = await conn
    .select()
    .from(docsSpaces)
    .where(and(eq(docsSpaces.visibility, "team"), isNull(docsSpaces.archivedAt)))
    .orderBy(asc(docsSpaces.createdAt))
    .limit(1);
  return row ?? null;
}

export async function createSpace(conn: Conn, input: { name: string; description: string; visibility: "team" | "private" }, by: Viewer): Promise<Space> {
  const [space] = await conn.insert(docsSpaces).values({ ...input, createdBy: by.id }).returning();
  // Whoever makes a space manages it.
  await conn.insert(docsSpaceMembers).values({ spaceId: space.id, userId: by.id, role: "manager" }).onConflictDoNothing();
  await audit(
    {
      actor: userActor(by),
      action: "docs.space_created",
      module: MODULE_ID,
      target: { type: "docs_space", id: space.id },
      summary: `${by.name} made the ${input.visibility} space "${space.name}".`,
      visibility: input.visibility === "team" ? "everyone" : "admins",
    },
    conn,
  );
  return space;
}

export async function updateSpace(ctx: ModuleContext, space: SpaceWithAccess, input: { name: string; description: string; visibility: "team" | "private" }): Promise<void> {
  if (!canManage(space.access)) throw new UserError("Only the space's managers can change it. Ask one of them, or an admin.");
  await ctx.db.update(docsSpaces).set(input).where(eq(docsSpaces.id, space.id));
  await audit({
    actor: userActor(ctx.viewer),
    action: "docs.space_changed",
    module: MODULE_ID,
    target: { type: "docs_space", id: space.id },
    summary: `${ctx.viewer.name} changed the space "${input.name}"${input.visibility !== space.visibility ? ` (now ${input.visibility})` : ""}.`,
  });
}

export async function setSpaceArchived(ctx: ModuleContext, space: SpaceWithAccess, archived: boolean): Promise<void> {
  if (!canManage(space.access)) throw new UserError("Only the space's managers can archive it. Ask one of them, or an admin.");
  await ctx.db.update(docsSpaces).set({ archivedAt: archived ? new Date() : null }).where(eq(docsSpaces.id, space.id));
  await audit({
    actor: userActor(ctx.viewer),
    action: archived ? "docs.space_archived" : "docs.space_restored",
    module: MODULE_ID,
    target: { type: "docs_space", id: space.id },
    summary: `${ctx.viewer.name} ${archived ? "archived" : "brought back"} the space "${space.name}".`,
  });
}

export async function spaceMembers(conn: Conn, spaceId: string) {
  return conn
    .select({ userId: users.id, name: users.name, email: users.email, userRole: users.role, role: docsSpaceMembers.role })
    .from(docsSpaceMembers)
    .innerJoin(users, eq(users.id, docsSpaceMembers.userId))
    .where(eq(docsSpaceMembers.spaceId, spaceId))
    .orderBy(asc(users.name));
}

export async function activePeople(conn: Conn) {
  return conn.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(eq(users.status, "active")).orderBy(asc(users.name));
}

export async function setMember(ctx: ModuleContext, space: SpaceWithAccess, userId: string, role: SpaceRole): Promise<void> {
  if (!canManage(space.access)) throw new UserError("Only the space's managers can change who is in it.");
  const [person] = await ctx.db.select({ id: users.id, name: users.name, role: users.role, status: users.status }).from(users).where(eq(users.id, userId));
  if (!person || person.status !== "active") throw new UserError("That person's account is not active. Pick someone else.");
  if (person.role === "guest" && role === "manager") throw new UserError("A guest cannot manage a space. Make them a reader or an editor.");
  await ctx.db
    .insert(docsSpaceMembers)
    .values({ spaceId: space.id, userId, role })
    .onConflictDoUpdate({ target: [docsSpaceMembers.spaceId, docsSpaceMembers.userId], set: { role } });
  await audit({
    actor: userActor(ctx.viewer),
    action: "docs.member_set",
    module: MODULE_ID,
    target: { type: "docs_space", id: space.id },
    summary: `${ctx.viewer.name} gave ${person.name} "${role}" in the space "${space.name}".`,
  });
}

export async function removeMember(ctx: ModuleContext, space: SpaceWithAccess, userId: string): Promise<void> {
  if (!canManage(space.access)) throw new UserError("Only the space's managers can change who is in it.");
  const managers = (await spaceMembers(ctx.db, space.id)).filter((m) => m.role === "manager");
  if (managers.length === 1 && managers[0].userId === userId && !ctx.can(P.manage)) {
    throw new UserError("This is the space's last manager. Make someone else a manager first.");
  }
  const [gone] = await ctx.db
    .delete(docsSpaceMembers)
    .where(and(eq(docsSpaceMembers.spaceId, space.id), eq(docsSpaceMembers.userId, userId)))
    .returning({ userId: docsSpaceMembers.userId });
  if (gone) {
    await audit({
      actor: userActor(ctx.viewer),
      action: "docs.member_removed",
      module: MODULE_ID,
      target: { type: "docs_space", id: space.id },
      summary: `${ctx.viewer.name} removed someone from the space "${space.name}".`,
    });
  }
}

// ── Pages ────────────────────────────────────────────────────────────────────

export type TreeRow = Pick<Page, "id" | "parentId" | "title" | "kind" | "isTemplate" | "updatedAt" | "schedule" | "scheduleDay">;

/** Every live page of a space, light columns only, for the tree. */
export async function spacePages(conn: Conn, spaceId: string): Promise<TreeRow[]> {
  return conn
    .select({
      id: docsPages.id,
      parentId: docsPages.parentId,
      title: docsPages.title,
      kind: docsPages.kind,
      isTemplate: docsPages.isTemplate,
      updatedAt: docsPages.updatedAt,
      schedule: docsPages.schedule,
      scheduleDay: docsPages.scheduleDay,
    })
    .from(docsPages)
    .where(and(eq(docsPages.spaceId, spaceId), isNull(docsPages.archivedAt)))
    .orderBy(sql`lower(${docsPages.title})`);
}

export interface TreeNode {
  page: TreeRow;
  children: TreeNode[];
}

/** Nests the rows by parent (alphabetical at every level). Pages whose parent is gone sit at the top. */
export function buildTree(rows: TreeRow[]): TreeNode[] {
  const byId = new Map(rows.map((r) => [r.id, { page: r, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.page.parentId ? byId.get(node.page.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

export type PageWithSpace = Page & { space: SpaceWithAccess };

/** A page the person can read (archived pages too), with its space and their access. */
export async function getPage(conn: Conn, who: Who, id: string): Promise<PageWithSpace | null> {
  const [page] = await conn.select(pageColumns).from(docsPages).where(eq(docsPages.id, id));
  if (!page) return null;
  const space = await getSpace(conn, who, page.spaceId);
  return space ? { ...page, space } : null;
}

/** Parent and grandparents, nearest last, for the breadcrumb. */
export async function ancestors(conn: Conn, page: Pick<Page, "parentId">): Promise<{ id: string; title: string }[]> {
  if (!page.parentId) return [];
  const rows = await conn.execute<{ id: string; title: string; depth: number }>(sql`
    with recursive up as (
      select id, title, parent_id, 1 as depth from docs_pages where id = ${page.parentId}
      union all
      select p.id, p.title, p.parent_id, up.depth + 1 from docs_pages p join up on p.id = up.parent_id where up.depth < 20
    )
    select id, title, depth from up order by depth desc`);
  return rows.map((r) => ({ id: r.id, title: r.title }));
}

/** The page and every page under it. */
export async function subtreeIds(conn: Conn, pageId: string): Promise<string[]> {
  const rows = await conn.execute<{ id: string }>(sql`
    with recursive down as (
      select id, 1 as depth from docs_pages where id = ${pageId}
      union all
      select p.id, down.depth + 1 from docs_pages p join down on p.parent_id = down.id where down.depth < 50
    )
    select id from down`);
  return rows.map((r) => r.id);
}

async function checkParent(conn: Conn, spaceId: string, parentId: string | null | undefined, selfId?: string): Promise<string | null> {
  if (!parentId) return null;
  const [parent] = await conn.select({ id: docsPages.id, spaceId: docsPages.spaceId, archivedAt: docsPages.archivedAt }).from(docsPages).where(eq(docsPages.id, parentId));
  if (!parent || parent.spaceId !== spaceId || parent.archivedAt) throw new UserError("The page you chose to put it under is not in this space any more. Pick another, or put it at the top.");
  if (selfId && (await subtreeIds(conn, selfId)).includes(parentId)) throw new UserError("A page cannot go under itself or one of its own sub-pages. Pick another place.");
  return parentId;
}

function sameSteps(a: ProcedureStep[], b: ProcedureStep[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Rebuilds the page's outgoing links from its text: [[Title]] (same space first, then any space) and /m/docs/p/<id>. */
export async function rebuildLinks(conn: Conn, page: { id: string; spaceId: string; body: string; steps: ProcedureStep[] }): Promise<void> {
  const text = `${page.body}\n${page.steps.map((s) => `${s.text}\n${s.note}`).join("\n")}`;
  const { titles, ids } = extractLinks(text);
  const targets = new Set<string>();
  if (titles.length) {
    const lower = titles.map((t) => t.toLowerCase());
    const rows = await conn
      .select({ id: docsPages.id, title: docsPages.title, spaceId: docsPages.spaceId })
      .from(docsPages)
      .where(and(isNull(docsPages.archivedAt), inArray(sql`lower(${docsPages.title})`, lower)));
    for (const t of lower) {
      const hits = rows.filter((r) => r.title.toLowerCase() === t);
      const best = hits.find((r) => r.spaceId === page.spaceId) ?? hits[0];
      if (best) targets.add(best.id);
    }
  }
  if (ids.length) {
    const rows = await conn.select({ id: docsPages.id }).from(docsPages).where(inArray(docsPages.id, ids));
    for (const r of rows) targets.add(r.id);
  }
  targets.delete(page.id);
  await conn.delete(docsLinks).where(eq(docsLinks.fromPageId, page.id));
  if (targets.size) await conn.insert(docsLinks).values([...targets].map((toPageId) => ({ fromPageId: page.id, toPageId }))).onConflictDoNothing();
}

/** After a page is created or renamed, links elsewhere that named it by title now find it. */
async function relinkTitle(conn: Conn, title: string): Promise<void> {
  const pattern = `%[[${title.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await conn
    .select({ id: docsPages.id, spaceId: docsPages.spaceId, body: docsPages.body, steps: docsPages.steps })
    .from(docsPages)
    .where(and(isNull(docsPages.archivedAt), sql`${docsPages.body} ilike ${pattern}`))
    .limit(200);
  for (const r of rows) await rebuildLinks(conn, r);
}

function visibilityOf(space: { visibility: "team" | "private" }) {
  return space.visibility === "team" ? ("everyone" as const) : ("admins" as const);
}

const VIA_NOTE: Record<Via, string> = { user: "", ai: " (drafted by the assistant, approved)", import: " (imported, approved)", restore: "" };

export interface NewPage extends PageFields {
  spaceId: string;
  parentId?: string | null;
  note?: string;
  importPath?: string | null;
  sourceKey?: string | null;
}

/** Writes a new page, its first revision, its links and an activity entry. */
export async function createPage(conn: Conn, input: NewPage, author: { id: string; name: string }, via: Via = "user"): Promise<Page> {
  const [space] = await conn.select().from(docsSpaces).where(eq(docsSpaces.id, input.spaceId));
  if (!space) throw new UserError("That space no longer exists. Pick another space.");
  const parentId = await checkParent(conn, input.spaceId, input.parentId);
  const isProcedure = input.kind === "procedure";
  const [page] = await conn
    .insert(docsPages)
    .values({
      spaceId: input.spaceId,
      parentId,
      title: input.title,
      body: input.body,
      kind: input.kind,
      steps: isProcedure ? input.steps : [],
      schedule: isProcedure ? input.schedule : "none",
      scheduleDay: isProcedure && input.schedule === "weekly" ? (input.scheduleDay ?? 1) : null,
      isTemplate: input.isTemplate,
      createdBy: author.id,
      updatedBy: author.id,
      updatedByName: author.name,
      importPath: input.importPath ?? null,
      sourceKey: input.sourceKey ?? null,
    })
    .returning(pageColumns);
  await conn.insert(docsRevisions).values({
    pageId: page.id,
    revision: 1,
    title: page.title,
    body: page.body,
    kind: page.kind,
    steps: page.steps,
    note: input.note || "First version",
    editedBy: author.id,
    editedByName: author.name,
    via,
  });
  await rebuildLinks(conn, page);
  await relinkTitle(conn, page.title);
  await audit(
    {
      actor: userActor(author),
      action: "docs.page_created",
      module: MODULE_ID,
      target: { type: "docs_page", id: page.id },
      summary: `${author.name} wrote the ${page.kind} "${page.title}" in ${space.name}${VIA_NOTE[via]}.`,
      visibility: visibilityOf(space),
    },
    conn,
  );
  return page;
}

export interface PageChange {
  title?: string;
  body?: string;
  kind?: "page" | "procedure";
  steps?: ProcedureStep[];
  schedule?: "none" | "daily" | "weekdays" | "weekly";
  scheduleDay?: number | null;
  isTemplate?: boolean;
  parentId?: string | null;
  note?: string;
}

/**
 * Saves a change as a new revision, but only if nobody saved since
 * `baseRevision` (one conditional UPDATE). Returns the page, or throws a
 * message that says who changed it in between.
 */
export async function savePage(conn: Conn, pageId: string, baseRevision: number, change: PageChange, editor: { id: string; name: string }, via: Via = "user"): Promise<{ page: Page; changed: boolean }> {
  const [current] = await conn.select(pageColumns).from(docsPages).where(eq(docsPages.id, pageId));
  if (!current) throw new UserError("This page no longer exists.");
  if (current.revision !== baseRevision) {
    throw new UserError(
      `${current.updatedByName} saved this page after you opened it (it is now version ${current.revision}; yours started from version ${baseRevision}). Nothing was saved. Copy your text, reload the page, and add your change again.`,
    );
  }
  const kind = change.kind ?? current.kind;
  const next = {
    title: change.title ?? current.title,
    body: change.body ?? current.body,
    kind,
    steps: kind === "procedure" ? (change.steps ?? current.steps) : [],
    schedule: kind === "procedure" ? (change.schedule ?? current.schedule) : ("none" as const),
    scheduleDay: null as number | null,
    isTemplate: change.isTemplate ?? current.isTemplate,
    parentId: change.parentId === undefined ? current.parentId : await checkParent(conn, current.spaceId, change.parentId, current.id),
  };
  next.scheduleDay = next.schedule === "weekly" ? (change.scheduleDay ?? current.scheduleDay ?? 1) : null;
  const contentChanged = next.title !== current.title || next.body !== current.body || next.kind !== current.kind || !sameSteps(next.steps, current.steps);
  const settingsChanged =
    next.schedule !== current.schedule || next.scheduleDay !== current.scheduleDay || next.isTemplate !== current.isTemplate || next.parentId !== current.parentId;
  if (!contentChanged && !settingsChanged) return { page: current, changed: false };
  const revision = contentChanged ? current.revision + 1 : current.revision;
  const [page] = await conn
    .update(docsPages)
    .set({ ...next, revision, updatedBy: editor.id, updatedByName: editor.name, updatedAt: new Date() })
    .where(and(eq(docsPages.id, pageId), eq(docsPages.revision, baseRevision)))
    .returning(pageColumns);
  if (!page) throw new UserError("Someone saved this page at the same moment. Nothing was saved: reload the page and add your change again.");
  if (contentChanged) {
    await conn.insert(docsRevisions).values({
      pageId,
      revision,
      title: page.title,
      body: page.body,
      kind: page.kind,
      steps: page.steps,
      note: change.note ?? "",
      editedBy: editor.id,
      editedByName: editor.name,
      via,
    });
    await rebuildLinks(conn, page);
    if (page.title !== current.title) await relinkTitle(conn, page.title);
  }
  const [space] = await conn.select().from(docsSpaces).where(eq(docsSpaces.id, page.spaceId));
  await audit(
    {
      actor: userActor(editor),
      action: via === "restore" ? "docs.page_restored_version" : "docs.page_edited",
      module: MODULE_ID,
      target: { type: "docs_page", id: page.id },
      summary:
        via === "restore"
          ? `${editor.name} brought back an earlier version of "${page.title}" (now version ${revision}).`
          : `${editor.name} ${contentChanged ? "edited" : "changed the settings of"} "${page.title}"${page.title !== current.title ? ` (was "${current.title}")` : ""}${VIA_NOTE[via]}.`,
      visibility: space ? visibilityOf(space) : "admins",
    },
    conn,
  );
  return { page, changed: true };
}

export async function setPageArchived(ctx: ModuleContext, page: PageWithSpace, archived: boolean): Promise<number> {
  if (!canEdit(page.space.access)) throw new UserError("You can read this space but not change it. Ask one of its managers.");
  const ids = await subtreeIds(ctx.db, page.id);
  let count = 0;
  await ctx.db.transaction(async (tx) => {
    if (archived) {
      const now = new Date();
      const rows = await tx
        .update(docsPages)
        .set({ archivedAt: now })
        .where(and(inArray(docsPages.id, ids), isNull(docsPages.archivedAt)))
        .returning({ id: docsPages.id });
      count = rows.length;
    } else {
      // Bring back the pages that were archived together with this one.
      const rows = await tx
        .update(docsPages)
        .set({ archivedAt: null })
        .where(and(inArray(docsPages.id, ids), page.archivedAt ? eq(docsPages.archivedAt, page.archivedAt) : sql`false`))
        .returning({ id: docsPages.id });
      count = rows.length;
      if (page.parentId) {
        const [parent] = await tx.select({ archivedAt: docsPages.archivedAt }).from(docsPages).where(eq(docsPages.id, page.parentId));
        if (!parent || parent.archivedAt) await tx.update(docsPages).set({ parentId: null }).where(eq(docsPages.id, page.id));
      }
    }
    await audit(
      {
        actor: userActor(ctx.viewer),
        action: archived ? "docs.page_archived" : "docs.page_unarchived",
        module: MODULE_ID,
        target: { type: "docs_page", id: page.id },
        summary: `${ctx.viewer.name} ${archived ? "archived" : "brought back"} "${page.title}"${count > 1 ? ` and ${count - 1} page(s) under it` : ""}.`,
        visibility: visibilityOf(page.space),
      },
      tx,
    );
  });
  return count;
}

export async function archivedPages(conn: Conn, spaceIds: string[]) {
  if (spaceIds.length === 0) return [];
  return conn
    .select({ id: docsPages.id, title: docsPages.title, spaceId: docsPages.spaceId, spaceName: docsSpaces.name, archivedAt: docsPages.archivedAt, kind: docsPages.kind })
    .from(docsPages)
    .innerJoin(docsSpaces, eq(docsSpaces.id, docsPages.spaceId))
    .where(and(inArray(docsPages.spaceId, spaceIds), sql`${docsPages.archivedAt} is not null`))
    .orderBy(desc(docsPages.archivedAt))
    .limit(200);
}

export async function revisions(conn: Conn, pageId: string) {
  return conn
    .select({ revision: docsRevisions.revision, title: docsRevisions.title, note: docsRevisions.note, editedByName: docsRevisions.editedByName, via: docsRevisions.via, createdAt: docsRevisions.createdAt })
    .from(docsRevisions)
    .where(eq(docsRevisions.pageId, pageId))
    .orderBy(desc(docsRevisions.revision));
}

export async function revisionOf(conn: Conn, pageId: string, revision: number): Promise<Revision | null> {
  const [row] = await conn.select().from(docsRevisions).where(and(eq(docsRevisions.pageId, pageId), eq(docsRevisions.revision, revision)));
  return row ?? null;
}

export async function restoreRevision(ctx: ModuleContext, page: PageWithSpace, revision: number): Promise<Page> {
  if (!canEdit(page.space.access)) throw new UserError("You can read this space but not change it.");
  const old = await revisionOf(ctx.db, page.id, revision);
  if (!old) throw new UserError("That version does not exist. Open the history and pick another.");
  if (revision === page.revision) throw new UserError("That is already the current version.");
  const { page: saved } = await savePage(
    ctx.db,
    page.id,
    page.revision,
    { title: old.title, body: old.body, kind: old.kind, steps: old.steps, note: `Brought back version ${revision}` },
    ctx.viewer,
    "restore",
  );
  return saved;
}

/** Pages that link here, from spaces the person can read. */
export async function backlinks(conn: Conn, who: Who, pageId: string) {
  const ids = await readableSpaceIds(conn, who);
  if (ids.length === 0) return [];
  return conn
    .select({ id: docsPages.id, title: docsPages.title, spaceName: docsSpaces.name })
    .from(docsLinks)
    .innerJoin(docsPages, eq(docsPages.id, docsLinks.fromPageId))
    .innerJoin(docsSpaces, eq(docsSpaces.id, docsPages.spaceId))
    .where(and(eq(docsLinks.toPageId, pageId), isNull(docsPages.archivedAt), inArray(docsPages.spaceId, ids)))
    .orderBy(asc(docsPages.title));
}

/**
 * For rendering [[links]]: title (lower-case) → page id, from spaces the
 * person can read, preferring the page's own space.
 */
export async function resolveTitles(conn: Conn, who: Who, spaceId: string, titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (titles.length === 0) return out;
  const ids = await readableSpaceIds(conn, who);
  if (ids.length === 0) return out;
  const rows = await conn
    .select({ id: docsPages.id, title: docsPages.title, spaceId: docsPages.spaceId })
    .from(docsPages)
    .where(and(isNull(docsPages.archivedAt), inArray(docsPages.spaceId, ids), inArray(sql`lower(${docsPages.title})`, titles.map((t) => t.toLowerCase()))));
  for (const r of rows) {
    const key = r.title.toLowerCase();
    if (!out.has(key) || r.spaceId === spaceId) out.set(key, r.id);
  }
  return out;
}

/** Titles and ids of the pages the person can read (for the editor's preview and the "put it under" list). */
export async function pageDirectory(conn: Conn, who: Who, limit = 2000) {
  const ids = await readableSpaceIds(conn, who);
  if (ids.length === 0) return [];
  return conn
    .select({ id: docsPages.id, title: docsPages.title, spaceId: docsPages.spaceId })
    .from(docsPages)
    .where(and(isNull(docsPages.archivedAt), inArray(docsPages.spaceId, ids)))
    .orderBy(asc(docsPages.title))
    .limit(limit);
}

export async function templates(conn: Conn, who: Who) {
  const ids = await readableSpaceIds(conn, who);
  if (ids.length === 0) return [];
  return conn
    .select({ id: docsPages.id, title: docsPages.title, kind: docsPages.kind, spaceName: docsSpaces.name })
    .from(docsPages)
    .innerJoin(docsSpaces, eq(docsSpaces.id, docsPages.spaceId))
    .where(and(eq(docsPages.isTemplate, true), isNull(docsPages.archivedAt), inArray(docsPages.spaceId, ids)))
    .orderBy(asc(docsPages.title));
}

export async function recentPages(conn: Conn, who: Who, limit = 5) {
  const ids = await readableSpaceIds(conn, who);
  if (ids.length === 0) return [];
  return conn
    .select({ id: docsPages.id, title: docsPages.title, kind: docsPages.kind, updatedAt: docsPages.updatedAt, updatedByName: docsPages.updatedByName, spaceName: docsSpaces.name })
    .from(docsPages)
    .innerJoin(docsSpaces, eq(docsSpaces.id, docsPages.spaceId))
    .where(and(isNull(docsPages.archivedAt), eq(docsPages.isTemplate, false), inArray(docsPages.spaceId, ids)))
    .orderBy(desc(docsPages.updatedAt))
    .limit(limit);
}

export async function childPages(conn: Conn, pageId: string) {
  return conn
    .select({ id: docsPages.id, title: docsPages.title, kind: docsPages.kind })
    .from(docsPages)
    .where(and(eq(docsPages.parentId, pageId), isNull(docsPages.archivedAt)))
    .orderBy(sql`lower(${docsPages.title})`);
}

// ── Search ───────────────────────────────────────────────────────────────────

export async function searchPages(conn: Conn, who: Who, query: string, limit: number) {
  const ids = await readableSpaceIds(conn, who);
  if (ids.length === 0 || !query.trim()) return [];
  const q = sql`websearch_to_tsquery('simple', ${query})`;
  const rows = await conn
    .select({
      id: docsPages.id,
      title: docsPages.title,
      kind: docsPages.kind,
      spaceName: docsSpaces.name,
      updatedAt: docsPages.updatedAt,
      rank: sql<number>`ts_rank(${docsPages.search}, ${q})`,
      snippet: sql<string>`ts_headline('simple', ${docsPages.body}, ${q}, 'MaxWords=24, MinWords=8, StartSel=«, StopSel=»')`,
    })
    .from(docsPages)
    .innerJoin(docsSpaces, eq(docsSpaces.id, docsPages.spaceId))
    .where(and(sql`${docsPages.search} @@ ${q}`, isNull(docsPages.archivedAt), inArray(docsPages.spaceId, ids)))
    .orderBy(sql`6 desc`)
    .limit(limit);
  return rows.map((r) => ({ ...r, rank: Number(r.rank), snippet: plainText(r.snippet).slice(0, 300) }));
}

export async function searchHits(ctx: ModuleContext, query: string, limit: number): Promise<SearchHit[]> {
  return (await searchPages(ctx.db, ctx, query, limit)).map((r) => ({
    title: `${r.title} · ${r.spaceName}`,
    snippet: r.snippet,
    url: `/m/${MODULE_ID}/p/${r.id}`,
    rank: r.rank,
    at: r.updatedAt,
  }));
}

// ── Attachments ──────────────────────────────────────────────────────────────

export async function attachments(conn: Conn, pageId: string) {
  return conn.select().from(docsAttachments).where(eq(docsAttachments.pageId, pageId)).orderBy(asc(docsAttachments.createdAt));
}

/** Attaches a file the person just uploaded (only their own uploads to Docs can be attached). */
export async function addAttachment(ctx: ModuleContext, page: PageWithSpace, fileId: string) {
  if (!canEdit(page.space.access)) throw new UserError("You can read this space but not change it.");
  const [file] = await ctx.db.select().from(files).where(eq(files.id, fileId));
  if (!file || file.uploadedBy !== ctx.viewer.id || file.module !== MODULE_ID) throw new UserError("That upload could not be found. Upload the file again.");
  const [row] = await ctx.db
    .insert(docsAttachments)
    .values({ pageId: page.id, fileId: file.id, name: file.name, mime: file.mime, size: file.size, uploadedBy: ctx.viewer.id })
    .onConflictDoNothing()
    .returning();
  await audit({
    actor: userActor(ctx.viewer),
    action: "docs.attached",
    module: MODULE_ID,
    target: { type: "docs_page", id: page.id },
    summary: `${ctx.viewer.name} attached "${file.name}" to "${page.title}".`,
  });
  return row ?? null;
}

export async function removeAttachment(ctx: ModuleContext, page: PageWithSpace, attachmentId: string): Promise<void> {
  if (!canEdit(page.space.access)) throw new UserError("You can read this space but not change it.");
  const [row] = await ctx.db
    .delete(docsAttachments)
    .where(and(eq(docsAttachments.id, attachmentId), eq(docsAttachments.pageId, page.id)))
    .returning();
  if (!row) return;
  // The stored file goes too, unless another page still uses it.
  const [other] = await ctx.db.select({ id: docsAttachments.id }).from(docsAttachments).where(eq(docsAttachments.fileId, row.fileId)).limit(1);
  if (!other) await deleteStoredFile(row.fileId);
  await audit({
    actor: userActor(ctx.viewer),
    action: "docs.attachment_removed",
    module: MODULE_ID,
    target: { type: "docs_page", id: page.id },
    summary: `${ctx.viewer.name} removed "${row.name}" from "${page.title}".`,
  });
}

// ── Import ───────────────────────────────────────────────────────────────────

export function importKey(spaceId: string, path: string, content: { title: string; body: string; steps: unknown }): string {
  const hash = createHash("sha256").update(JSON.stringify([content.title, content.body, content.steps])).digest("hex").slice(0, 16);
  return `import:${spaceId}:${path.toLowerCase()}:${hash}`;
}

/** Finds or makes the folder pages for an import, by title under each parent. Returns the last one's id. */
export async function folderChain(conn: Conn, spaceId: string, folders: string[], by: { id: string; name: string }): Promise<string | null> {
  let parentId: string | null = null;
  for (const title of folders) {
    const [found]: { id: string }[] = await conn
      .select({ id: docsPages.id })
      .from(docsPages)
      .where(
        and(
          eq(docsPages.spaceId, spaceId),
          isNull(docsPages.archivedAt),
          parentId ? eq(docsPages.parentId, parentId) : isNull(docsPages.parentId),
          sql`lower(${docsPages.title}) = ${title.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (found) {
      parentId = found.id;
      continue;
    }
    const made: Page = await createPage(conn, { spaceId, parentId, title, body: "", kind: "page", steps: [], schedule: "none", scheduleDay: null, isTemplate: false, note: "Made by an import (a folder)" }, by, "import");
    parentId = made.id;
  }
  return parentId;
}

export async function pageByImportPath(conn: Conn, spaceId: string, path: string): Promise<Page | null> {
  const [row] = await conn
    .select(pageColumns)
    .from(docsPages)
    .where(and(eq(docsPages.spaceId, spaceId), eq(docsPages.importPath, path.toLowerCase())));
  return row ?? null;
}

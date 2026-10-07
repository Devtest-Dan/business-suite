import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { approve, propose } from "@/lib/approvals/ledger";
import { moduleContext } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { approvalItems } from "@/lib/db/schema";
import type { ModuleContext, Viewer } from "@/lib/modules/contract";
import {
  backlinks,
  createPage,
  createSpace,
  getPage,
  importKey,
  revisions,
  restoreRevision,
  savePage,
  searchPages,
  setMember,
  setPageArchived,
  spacePages,
  spacesFor,
  type NewPage,
} from "@/modules/docs/data";
import { completeStep, dueToday, finishRun, getRun, listRuns, startRun } from "@/modules/docs/runs";
import { docsPages, docsRevisions } from "@/modules/docs/schema";
import { seedDocs } from "@/modules/docs/seed";
import { parseMarkdownFile } from "@/modules/docs/text";
import { countRows, makeUser, resetDb } from "./helpers";

const ctxFor = (v: Viewer): Promise<ModuleContext> => moduleContext("docs", v);
const page = (spaceId: string, title: string, body = "", extra: Partial<NewPage> = {}): NewPage => ({
  spaceId,
  title,
  body,
  kind: "page",
  steps: [],
  schedule: "none",
  scheduleDay: null,
  isTemplate: false,
  ...extra,
});

describe("docs: spaces, pages, history, links (real Postgres)", () => {
  beforeEach(resetDb);

  it("private spaces are invisible to non-members, guests see only spaces they are added to", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member");
    const guest = await makeUser("guest");
    const team = await createSpace(db(), { name: "Team", description: "", visibility: "team" }, owner);
    const secret = await createSpace(db(), { name: "Management", description: "", visibility: "private" }, owner);
    await createPage(db(), page(secret.id, "Pay review notes", "salary bands"), owner);
    await createPage(db(), page(team.id, "Rota rules", "salary is paid monthly"), owner);

    const m = await ctxFor(member);
    expect((await spacesFor(m.db, m)).map((s) => s.name)).toEqual(["Team"]);
    expect((await searchPages(m.db, m, "salary", 10)).map((h) => h.title)).toEqual(["Rota rules"]);

    const g = await ctxFor(guest);
    expect(await spacesFor(g.db, g)).toEqual([]);
    expect(await searchPages(g.db, g, "salary", 10)).toEqual([]);
    const o = await ctxFor(owner);
    await setMember(o, (await spacesFor(o.db, o)).find((s) => s.id === team.id)!, guest.id, "viewer");
    expect((await spacesFor(g.db, g)).map((s) => [s.name, s.access])).toEqual([["Team", "read"]]);
    // The owner sees both.
    expect((await searchPages(o.db, o, "salary", 10)).length).toBe(2);
  });

  it("an edit must start from the current version; history keeps every version and restore adds one", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member", "Mia");
    const space = await createSpace(db(), { name: "Handbook", description: "", visibility: "team" }, owner);
    const p = await createPage(db(), page(space.id, "Holidays", "Book two weeks ahead."), owner);
    await savePage(db(), p.id, 1, { body: "Book three weeks ahead." }, member);
    await expect(savePage(db(), p.id, 1, { body: "Stale edit" }, owner)).rejects.toThrow(/Mia saved this page after you opened it/);
    expect((await revisions(db(), p.id)).map((r) => r.revision)).toEqual([2, 1]);

    const o = await ctxFor(owner);
    const current = (await getPage(o.db, o, p.id))!;
    const restored = await restoreRevision(o, current, 1);
    expect(restored.revision).toBe(3);
    expect(restored.body).toBe("Book two weeks ahead.");
    const [r3] = await db().select().from(docsRevisions).where(eq(docsRevisions.revision, 3));
    expect(r3.via).toBe("restore");
  });

  it("[[links]] become backlinks, also when the target page is written later", async () => {
    const owner = await makeUser("owner");
    const space = await createSpace(db(), { name: "Handbook", description: "", visibility: "team" }, owner);
    const a = await createPage(db(), page(space.id, "Start", "Read [[Fire safety]] first."), owner);
    const b = await createPage(db(), page(space.id, "Fire safety", "Exits are marked."), owner);
    const o = await ctxFor(owner);
    expect((await backlinks(o.db, o, b.id)).map((l) => l.id)).toEqual([a.id]);
    await savePage(db(), a.id, 1, { body: "Nothing linked now." }, owner);
    expect(await backlinks(o.db, o, b.id)).toEqual([]);
  });

  it("archiving a page archives the pages under it, and bringing it back restores them together", async () => {
    const owner = await makeUser("owner");
    const space = await createSpace(db(), { name: "Handbook", description: "", visibility: "team" }, owner);
    const parent = await createPage(db(), page(space.id, "Kitchen"), owner);
    await createPage(db(), page(space.id, "Knives", "", { parentId: parent.id }), owner);
    const o = await ctxFor(owner);
    expect(await setPageArchived(o, (await getPage(o.db, o, parent.id))!, true)).toBe(2);
    expect(await spacePages(db(), space.id)).toEqual([]);
    expect(await setPageArchived(o, (await getPage(o.db, o, parent.id))!, false)).toBe(2);
    expect((await spacePages(db(), space.id)).length).toBe(2);
  });

  it("refuses to put a page under its own sub-page", async () => {
    const owner = await makeUser("owner");
    const space = await createSpace(db(), { name: "H", description: "", visibility: "team" }, owner);
    const top = await createPage(db(), page(space.id, "Top"), owner);
    const child = await createPage(db(), page(space.id, "Child", "", { parentId: top.id }), owner);
    await expect(savePage(db(), top.id, 1, { parentId: child.id }, owner)).rejects.toThrow(/cannot go under itself/);
  });

  it("the seed makes a team space with example pages, procedures and templates, once", async () => {
    const owner = await makeUser("owner");
    const o = await ctxFor(owner);
    await seedDocs(o);
    await seedDocs(o);
    expect(await countRows("docs_spaces")).toBe(1);
    const rows = await db().select({ title: docsPages.title, kind: docsPages.kind, isTemplate: docsPages.isTemplate }).from(docsPages);
    expect(rows.filter((r) => r.kind === "procedure" && !r.isTemplate).length).toBe(3);
    expect(rows.filter((r) => r.isTemplate).length).toBe(2);
    expect(rows.every((r) => r.isTemplate || r.title.includes("(example)"))).toBe(true);
    // "Start here" linked to the checklist before it existed; the link was found when the checklist was written.
    const checklist = (await searchPages(o.db, o, "fridge thermometer", 5))[0];
    expect((await backlinks(o.db, o, checklist.id)).map((b) => b.title)).toContain("Start here (example)");
  });
});

describe("docs: writes through the approvals inbox", () => {
  beforeEach(resetDb);

  it("an AI-drafted page is one approval, written once even when approved twice", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member");
    await createSpace(db(), { name: "Handbook", description: "", visibility: "team" }, owner);
    const r = await propose({ action: "docs.create_page", items: [{ title: "Returns policy", body: "We take returns within 30 days." }], source: "ai", requestedBy: member, keys: ["ai:call-1:0"] });
    expect(r.accepted).toBe(1);
    expect(await countRows("docs_pages")).toBe(0);
    await approve(r.approvalId!, owner);
    await approve(r.approvalId!, owner);
    const rows = await db().select().from(docsPages);
    expect(rows.map((p) => p.title)).toEqual(["Returns policy"]);
    const [rev] = await db().select().from(docsRevisions);
    expect(rev.via).toBe("ai");
    expect(rev.editedByName).toBe(member.name);
  });

  it("a proposed change based on an old version fails with a reason and writes nothing", async () => {
    const owner = await makeUser("owner");
    const space = await createSpace(db(), { name: "Handbook", description: "", visibility: "team" }, owner);
    const p = await createPage(db(), page(space.id, "Hours", "Open 9 to 5."), owner);
    const r = await propose({ action: "docs.edit_page", items: [{ pageId: p.id, baseRevision: 1, body: "Open 8 to 6." }], source: "ai", requestedBy: owner });
    await savePage(db(), p.id, 1, { body: "Open 9 to 6." }, owner); // someone edits first
    const report = await approve(r.approvalId!, owner);
    expect(report.failedNow).toBe(1);
    expect(report.failures[0].error).toMatch(/saved this page after you opened it/);
    const [now] = await db().select().from(docsPages);
    expect(now.body).toBe("Open 9 to 6.");

    const ok = await propose({ action: "docs.edit_page", items: [{ pageId: p.id, baseRevision: 2, body: "Open 8 to 6.", note: "Longer hours" }], source: "ai", requestedBy: owner });
    expect((await approve(ok.approvalId!, owner)).appliedNow).toBe(1);
    const [after] = await db().select().from(docsPages);
    expect(after.revision).toBe(3);
  });

  it("a proposed change that leaves out the steps (or the text) keeps them as they are", async () => {
    const owner = await makeUser("owner");
    const space = await createSpace(db(), { name: "Handbook", description: "", visibility: "team" }, owner);
    const steps = [{ text: "Lights on", note: "", check: "none" as const, checkLabel: "" }];
    const p = await createPage(db(), page(space.id, "Opening", "Intro.", { kind: "procedure", steps }), owner);
    const r = await propose({ action: "docs.edit_page", items: [{ pageId: p.id, baseRevision: 1, body: "Intro, longer." }], source: "ai", requestedBy: owner });
    await approve(r.approvalId!, owner);
    const t = await propose({ action: "docs.edit_page", items: [{ pageId: p.id, baseRevision: 2, title: "Opening up" }], source: "ai", requestedBy: owner });
    await approve(t.approvalId!, owner);
    const [after] = await db().select().from(docsPages);
    expect(after).toMatchObject({ title: "Opening up", body: "Intro, longer.", steps, revision: 3 });
  });

  it("a member who cannot write in a private space cannot get a page into it through the AI", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member");
    const secret = await createSpace(db(), { name: "Management", description: "", visibility: "private" }, owner);
    const r = await propose({ action: "docs.create_page", items: [{ spaceId: secret.id, title: "Sneaky", body: "x" }], source: "ai", requestedBy: member });
    const report = await approve(r.approvalId!, owner);
    expect(report.failedNow).toBe(1);
    expect(report.failures[0].error).toMatch(/cannot open that space/);
    expect(await countRows("docs_pages")).toBe(0);
  });

  it("a Markdown import is one approval with folders; the same files again are left out; a changed file updates its page", async () => {
    const owner = await makeUser("owner");
    const space = await createSpace(db(), { name: "Handbook", description: "", visibility: "team" }, owner);
    const files = [
      { path: "Kitchen/opening.md", text: "---\nkind: procedure\n---\n# Opening\n\n1. Lights on\n2. Fridge [check: yes/no: Cold?]" },
      { path: "Kitchen/knives.md", text: "# Knife safety\n\nAlways cut away from you." },
      { path: "welcome.md", text: "# Welcome\n\nHello." },
    ];
    const items = (list: typeof files) => list.map((f) => ({ spaceId: space.id, path: f.path, ...parseMarkdownFile(f.path, f.text) }));
    const keys = (list: typeof files) => items(list).map((it) => importKey(space.id, it.path, it));
    const first = await propose({ action: "docs.import_page", items: items(files), keys: keys(files), source: "import", requestedBy: owner });
    expect(first.accepted).toBe(3);
    await approve(first.approvalId!, owner);
    await approve(first.approvalId!, owner);
    const titles = (await spacePages(db(), space.id)).map((p) => p.title).sort();
    expect(titles).toEqual(["Kitchen", "Knife safety", "Opening", "Welcome"]); // one folder page, made once
    const [opening] = await db().select().from(docsPages).where(eq(docsPages.title, "Opening"));
    expect(opening.kind).toBe("procedure");
    expect(opening.steps[1]).toMatchObject({ check: "yesno", checkLabel: "Cold?" });

    const again = await propose({ action: "docs.import_page", items: items(files), keys: keys(files), source: "import", requestedBy: owner });
    expect(again.approvalId).toBeNull();
    expect(again.duplicates).toBe(3);

    const changed = [{ path: "welcome.md", text: "# Welcome\n\nHello, and welcome." }];
    const third = await propose({ action: "docs.import_page", items: items(changed), keys: keys(changed), source: "import", requestedBy: owner });
    await approve(third.approvalId!, owner);
    const [welcome] = await db().select().from(docsPages).where(eq(docsPages.title, "Welcome"));
    expect(welcome.body).toBe("Hello, and welcome.");
    expect(welcome.revision).toBe(2);
    expect(await countRows("docs_pages")).toBe(4);
    const items3 = await db().select().from(approvalItems).where(eq(approvalItems.approvalId, third.approvalId!));
    expect(items3[0].status).toBe("applied");
  });
});

describe("docs: procedure runs", () => {
  beforeEach(resetDb);

  async function procedure(owner: Viewer) {
    const space = await createSpace(db(), { name: "Shop", description: "", visibility: "team" }, owner);
    return createPage(
      db(),
      page(space.id, "Opening", "", {
        kind: "procedure",
        schedule: "daily",
        steps: [
          { text: "Lights on", note: "", check: "none", checkLabel: "" },
          { text: "Fridge", note: "", check: "yesno", checkLabel: "Cold?" },
          { text: "Float", note: "", check: "value", checkLabel: "Amount" },
        ],
      }),
      owner,
    );
  }

  it("records who did each step; a No flags the run; finishing needs every step and happens once", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member", "Max");
    const proc = await procedure(owner);
    const o = await ctxFor(owner);
    const m = await ctxFor(member);
    const run = await startRun(o, (await getPage(o.db, o, proc.id))!, { assignedTo: member.id });
    expect(await countRows("notifications")).toBe(1); // the assignee is told

    expect((await dueToday(m.db, m, "UTC"))[0]).toMatchObject({ title: "Opening", state: "open" });
    const load = async () => (await getRun(m.db, m, run.id))!;
    await completeStep(m, await load(), 0, "");
    await expect(completeStep(o, await load(), 0, "")).rejects.toThrow(/Max already ticked step 1/);
    await expect(completeStep(m, await load(), 1, "maybe")).rejects.toThrow(/answer Yes or No/);
    await completeStep(m, await load(), 1, "No");
    await expect(finishRun(m, await load())).rejects.toThrow(/Step 3 is not ticked/);
    await expect(completeStep(m, await load(), 2, "")).rejects.toThrow(/record “Amount”/);
    await completeStep(m, await load(), 2, "150.00");
    const done = await finishRun(m, await load());
    expect(done.status).toBe("completed");
    expect(done.flagged).toBe(true);
    await expect(finishRun(m, await load())).rejects.toThrow(/already finished/);
    expect((await dueToday(m.db, m, "UTC"))[0].state).toBe("done");
    expect((await listRuns(m.db, m, { pageId: proc.id }))[0]).toMatchObject({ doneCount: 3, stepCount: 3, completedByName: "Max" });
  });

  it("a later edit of the procedure does not change a run in progress", async () => {
    const owner = await makeUser("owner");
    const proc = await procedure(owner);
    const o = await ctxFor(owner);
    const run = await startRun(o, (await getPage(o.db, o, proc.id))!, {});
    await savePage(db(), proc.id, 1, { steps: [{ text: "Only step", note: "", check: "none", checkLabel: "" }] }, owner);
    expect((await getRun(o.db, o, run.id))!.steps.length).toBe(3);
  });

  it("a run cannot be given to someone who cannot open the space", async () => {
    const owner = await makeUser("owner");
    const guest = await makeUser("guest");
    const proc = await procedure(owner);
    const o = await ctxFor(owner);
    await expect(startRun(o, (await getPage(o.db, o, proc.id))!, { assignedTo: guest.id })).rejects.toThrow(/cannot open this space/);
  });
});

import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { approve, propose } from "@/lib/approvals/ledger";
import { moduleContext } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { notifications } from "@/lib/db/schema";
import type { Viewer } from "@/lib/modules/contract";
import { MODULE_ID } from "@/modules/tasks/constants";
import {
  addComment,
  createProject,
  createTask,
  dueSummary,
  getProject,
  getTask,
  listProjects,
  listTasks,
  moveTask,
  projectFromTemplate,
  saveAsTemplate,
  searchTasks,
  seedDemo,
  sendDueReminders,
  setTaskStatus,
  updateTask,
} from "@/modules/tasks/data";
import { ahlDedupeKey, ahlRecordsToInputs, csvToTaskRecords, parseAhlExport } from "@/modules/tasks/imports";
import { addDays, todayIn } from "@/modules/tasks/logic";
import { tasks as tasksTable } from "@/modules/tasks/schema";
import { countRows, makeUser, resetDb } from "./helpers";

const ctxFor = (v: Viewer) => moduleContext(MODULE_ID, v);
const today = () => todayIn("UTC");

async function project(owner: Viewer, name = "Shop", visibility: "team" | "private" = "team") {
  return createProject(db(), { name, description: "", visibility }, owner);
}

async function notices(userId: string, kind: string) {
  return db()
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.kind, kind)));
}

describe("tasks module (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates a task with assignees, watchers, checklist and history; assignees join the project", async () => {
    const owner = await makeUser("owner", "Olive Owner");
    const member = await makeUser("member", "Max Member");
    const p = await project(owner, "Private work", "private");
    const { task, notifyAssigned } = await createTask(db(), { projectId: p.id, title: "Fix the door", assigneeIds: [member.id], checklist: ["Call", "Pay"], labels: ["repairs"] }, owner);
    await notifyAssigned();
    const detail = await getTask(await ctxFor(member), task.id);
    expect(detail?.assignees.map((a) => a.name)).toEqual(["Max Member"]);
    expect(detail?.watchers.map((w) => w.name).sort()).toEqual(["Max Member", "Olive Owner"]);
    expect(detail?.checklist.map((c) => c.text)).toEqual(["Call", "Pay"]);
    expect(detail?.activity[0].summary).toBe("Created the task.");
    expect(await notices(member.id, "tasks.assigned")).toHaveLength(1);
    await createTask(db(), { projectId: p.id, title: "Late", dueOn: "2020-01-01" }, owner);
    const [counts] = await listProjects(await ctxFor(member));
    expect([counts.open, counts.overdue, counts.done]).toEqual([2, 1, 0]);
  });

  it("private projects are visible only to members and managers; guests only to projects they are in", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member");
    const guest = await makeUser("guest");
    const priv = await project(owner, "Payroll prep", "private");
    const team = await project(owner, "Team stuff", "team");
    await createTask(db(), { projectId: priv.id, title: "Secret" }, owner);
    await createTask(db(), { projectId: team.id, title: "Open" }, owner);
    expect((await listTasks(await ctxFor(member))).map((t) => t.title)).toEqual(["Open"]);
    expect(await getProject(await ctxFor(member), priv.id)).toBeNull();
    expect(await listTasks(await ctxFor(guest))).toEqual([]);
    expect((await listTasks(await ctxFor(owner))).map((t) => t.title).sort()).toEqual(["Open", "Secret"]);
    expect((await searchTasks(await ctxFor(member), "secret", 10)).length).toBe(0);
    expect((await searchTasks(await ctxFor(owner), "secret", 10)).map((h) => h.title)).toEqual(["Secret"]);
  });

  it("a repeating task makes its next copy once, even if it is done twice", async () => {
    const owner = await makeUser("owner");
    const p = await project(owner);
    const { task } = await createTask(db(), { projectId: p.id, title: "Water plants", dueOn: today(), recurrence: "weekly", checklist: ["Front", "Back"], assigneeIds: [owner.id] }, owner);
    const first = await db().transaction((tx) => setTaskStatus(tx, task.id, "done", owner, { timezone: "UTC" }));
    expect(first.next?.dueOn).toBe(addDays(today(), 7));
    await db().transaction((tx) => setTaskStatus(tx, task.id, "todo", owner, { timezone: "UTC" }));
    const again = await db().transaction((tx) => setTaskStatus(tx, task.id, "done", owner, { timezone: "UTC" }));
    expect(again.next).toBeNull();
    const copies = await db().select().from(tasksTable).where(eq(tasksTable.title, "Water plants"));
    expect(copies).toHaveLength(2);
    const next = await getTask(await ctxFor(owner), first.next!.id);
    expect(next?.checklist.map((c) => c.done)).toEqual([false, false]);
    expect(next?.assignees).toHaveLength(1);
  });

  it("moves cards on the board to a column and a place", async () => {
    const owner = await makeUser("owner");
    const p = await project(owner);
    const a = (await createTask(db(), { projectId: p.id, title: "A" }, owner)).task;
    const b = (await createTask(db(), { projectId: p.id, title: "B" }, owner)).task;
    const c = (await createTask(db(), { projectId: p.id, title: "C" }, owner)).task;
    const ctx = await ctxFor(owner);
    await moveTask(ctx, c.id, "todo", 0);
    expect((await listTasks(ctx, { projectId: p.id, sort: "board" })).map((t) => t.title)).toEqual(["C", "A", "B"]);
    await moveTask(ctx, a.id, "doing", 0);
    await moveTask(ctx, b.id, "doing", 0);
    const doing = await listTasks(ctx, { projectId: p.id, statuses: ["doing"], sort: "board" });
    expect(doing.map((t) => t.title)).toEqual(["B", "A"]);
    expect((await getTask(ctx, a.id))?.activity[0].summary).toBe("Moved it from To do to Doing.");
  });

  it("edits record each change in the history and notify new assignees", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member", "Max Member");
    const p = await project(owner);
    const { task } = await createTask(db(), { projectId: p.id, title: "Quote" }, owner);
    await updateTask(await ctxFor(owner), task.id, { title: "Quote for Lee", description: "", priority: "high", dueOn: "2026-11-01", dueOffsetDays: null, labels: ["sales"], recurrence: "none", assigneeIds: [member.id] });
    const detail = await getTask(await ctxFor(owner), task.id);
    const lines = detail!.activity.map((a) => a.summary);
    expect(lines).toEqual(expect.arrayContaining(["Renamed it from “Quote” to “Quote for Lee”.", "Set the priority to high.", "Set the due date to 2026-11-01.", "Assigned it to Max Member."]));
    expect(await notices(member.id, "tasks.assigned")).toHaveLength(1);
  });

  it("@mentions notify the person; other watchers get a comment notice", async () => {
    const owner = await makeUser("owner", "Olive Owner");
    const priya = await makeUser("member", "Priya Shah");
    const sam = await makeUser("member", "Sam Lee");
    const p = await project(owner);
    const { task } = await createTask(db(), { projectId: p.id, title: "Window", assigneeIds: [sam.id] }, owner);
    await addComment(await ctxFor(owner), task.id, "@Priya can you help Sam?");
    expect(await notices(priya.id, "tasks.mentioned")).toHaveLength(1);
    expect(await notices(sam.id, "tasks.commented")).toHaveLength(1);
    expect(await notices(owner.id, "tasks.commented")).toHaveLength(0);
  });

  it("reminders go once per task and due date, to the assignees", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member");
    const p = await project(owner);
    await createTask(db(), { projectId: p.id, title: "Late one", dueOn: addDays(today(), -2), assigneeIds: [member.id] }, owner);
    await createTask(db(), { projectId: p.id, title: "Today one", dueOn: today() }, owner);
    await createTask(db(), { projectId: p.id, title: "Later", dueOn: addDays(today(), 3) }, owner);
    expect(await sendDueReminders("UTC", { force: true })).toBe(2);
    expect(await sendDueReminders("UTC", { force: true })).toBe(0);
    expect((await notices(member.id, "tasks.due")).map((n) => n.title)).toEqual(["Overdue: Late one"]);
    expect((await notices(owner.id, "tasks.due")).map((n) => n.title)).toEqual(["Due today: Today one"]);
    const summary = await dueSummary(await ctxFor(member));
    expect(summary.overdue.map((t) => t.title)).toEqual(["Late one"]);
  });

  it("templates: save a project as a template and start a new project from it with real dates", async () => {
    const owner = await makeUser("owner");
    const p = await project(owner, "Onboarding Sam");
    await createTask(db(), { projectId: p.id, title: "Day one", dueOn: "2026-10-05", checklist: ["Keys"] }, owner);
    await createTask(db(), { projectId: p.id, title: "Week one", dueOn: "2026-10-09" }, owner);
    await createTask(db(), { projectId: p.id, title: "Sometime" }, owner);
    const ctx = await ctxFor(owner);
    const template = await saveAsTemplate(ctx, p.id, "Onboarding");
    const steps = await listTasks(ctx, { projectId: template.id, includeDone: true, sort: "board" });
    expect(steps.map((s) => [s.title, s.dueOffsetDays, s.dueOn])).toEqual([
      ["Day one", 0, null],
      ["Week one", 4, null],
      ["Sometime", null, null],
    ]);
    // Template tasks never appear in My tasks or lists across projects.
    expect((await listTasks(ctx)).some((t) => t.projectId === template.id)).toBe(false);
    const fresh = await projectFromTemplate(ctx, template.id, "Onboarding Ana", "2026-11-02");
    const made = await listTasks(ctx, { projectId: fresh.id, sort: "board" });
    expect(made.map((s) => [s.title, s.dueOn])).toEqual([
      ["Day one", "2026-11-02"],
      ["Week one", "2026-11-06"],
      ["Sometime", null],
    ]);
    expect(made[0].checklistTotal).toBe(1);
  });

  it("the demo seed is labelled as example data", async () => {
    const owner = await makeUser("owner");
    await seedDemo(await ctxFor(owner));
    const ctx = await ctxFor(owner);
    const rows = await listTasks(ctx, { includeDone: true });
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.projectName.startsWith("Example"))).toBe(true);
  });
});

describe("tasks writes through the approvals ledger", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("create_task: a batch of N is ONE approval; approving twice writes each once; bad records fail per record", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member", "Max Member");
    const p = await project(owner, "Shop");
    const items = [
      { project: "shop", title: "One", assignees: [member.email] },
      { project: p.id, title: "Two", dueOn: "2026-11-01", checklist: ["a"] },
      { project: "No such project", title: "Three" },
      { project: "Shop", title: "Four", assignees: ["nobody@example.test"] },
    ];
    const result = await propose({ action: "tasks.create_task", items, source: "ai", requestedBy: owner, keys: items.map((_, i) => `ai:call-1:${i}`) });
    expect(result.accepted).toBe(4);
    expect(await countRows("approvals")).toBe(1);
    expect(await countRows("tasks_tasks")).toBe(0);
    const first = await approve(result.approvalId!, owner);
    expect(first.appliedNow).toBe(2);
    expect(first.failures.map((f) => f.error)).toEqual([
      "There is no open project called “No such project”. Create it first, or choose another project.",
      "No one in the suite has the email or name “nobody@example.test”. Invite them first, or leave the task unassigned.",
    ]);
    expect(first.status).toBe("partially_applied");
    const second = await approve(result.approvalId!, owner);
    expect(second.appliedNow).toBe(0);
    expect(await countRows("tasks_tasks")).toBe(2);
    const one = (await listTasks(await ctxFor(member))).find((t) => t.title === "One");
    expect(one?.assignees.map((a) => a.name)).toEqual(["Max Member"]);
    expect((await getTask(await ctxFor(owner), one!.id))?.activity.at(-1)?.summary).toBe("Created the task (drafted by the assistant, approved).");
  });

  it("set_status: refuses when the title does not match, changes it when it does", async () => {
    const owner = await makeUser("owner");
    const p = await project(owner);
    const { task } = await createTask(db(), { projectId: p.id, title: "Call the landlord" }, owner);
    const r = await propose({
      action: "tasks.set_status",
      items: [
        { taskId: task.id, status: "done", title: "Something else" },
        { taskId: task.id, status: "doing", title: "call the landlord" },
      ],
      source: "ai",
      requestedBy: owner,
      keys: ["ai:x:0", "ai:x:1"],
    });
    const report = await approve(r.approvalId!, owner);
    expect(report.appliedNow).toBe(1);
    expect(report.failures[0].error).toContain("is now called “Call the landlord”");
    const [row] = await db().select().from(tasksTable).where(eq(tasksTable.id, task.id));
    expect(row.status).toBe("doing");
  });

  it("AHL export: one approval for the file, deduped by externalId; the same file again adds nothing; a newer export updates", async () => {
    const owner = await makeUser("owner");
    const intern = await makeUser("member", "Ivy Intern");
    const p = await project(owner, "Steps");
    const file = (updatedAt: string, title = "Share a safe sample of the data", status = "todo") =>
      JSON.stringify({
        format: "business-suite.tasks",
        version: 1,
        exportedAt: updatedAt,
        business: { name: "Rivera Plumbing" },
        tasks: [
          { externalId: "6f1c0e8a-0d5b-4c2e-9a41-2f7d3b1e9c10", title, detail: "Twenty quotes.", status, assignee: "owner", dueOn: null, source: { kind: "proposal", label: "Proposal: Quote drafts", ref: null, position: 1 }, updatedAt },
          { externalId: "7a2d0e8a-0d5b-4c2e-9a41-2f7d3b1e9c11", title: "Book a call with the intern", detail: "", status: "doing", assignee: "intern", dueOn: "2026-10-20", updatedAt: "2026-10-07T10:00:00.000Z" },
        ],
      });
    const send = async (text: string) => {
      const parsed = parseAhlExport(text);
      const items = ahlRecordsToInputs(parsed.tasks, { projectId: p.id, ownerId: owner.id, internId: intern.id });
      return propose({ action: "tasks.import_ahl_task", items, source: "import", requestedBy: owner, keys: items.map(ahlDedupeKey) });
    };
    const first = await send(file("2026-10-07T10:00:00.000Z"));
    expect(first.accepted).toBe(2);
    await approve(first.approvalId!, owner);
    await approve(first.approvalId!, owner);
    expect(await countRows("tasks_tasks")).toBe(2);

    const again = await send(file("2026-10-07T10:00:00.000Z"));
    expect(again.approvalId).toBeNull();
    expect(again.duplicates).toBe(2);

    const newer = await send(file("2026-10-08T09:00:00.000Z", "Share a safe sample (redacted)", "done"));
    expect(newer.accepted).toBe(1);
    expect(newer.duplicates).toBe(1);
    const report = await approve(newer.approvalId!, owner);
    expect(report.appliedNow).toBe(1);
    expect(await countRows("tasks_tasks")).toBe(2);
    const rows = await db().select().from(tasksTable).where(sql`${tasksTable.externalId} is not null`);
    const updated = rows.find((r) => r.externalId === "6f1c0e8a-0d5b-4c2e-9a41-2f7d3b1e9c10")!;
    expect(updated.title).toBe("Share a safe sample (redacted)");
    expect(updated.status).toBe("done");
    expect(updated.sourceLabel).toBe("Imported: Proposal: Quote drafts");
    const internTask = (await listTasks(await ctxFor(intern))).find((t) => t.title === "Book a call with the intern");
    expect(internTask?.assignees.map((a) => a.name)).toEqual(["Ivy Intern"]);
  });

  it("CSV import goes through create_task, keyed by the key column", async () => {
    const owner = await makeUser("owner");
    const p = await project(owner);
    const csv = "title,priority,due,key\nOrder rolls,high,2026-11-02,rolls\nClean sign,,,sign";
    const { records, keys } = csvToTaskRecords(csv, p.id);
    const r = await propose({ action: "tasks.create_task", items: records, source: "import", requestedBy: owner, keys });
    await approve(r.approvalId!, owner);
    const again = await propose({ action: "tasks.create_task", items: records, source: "import", requestedBy: owner, keys });
    expect(again.approvalId).toBeNull();
    expect(await countRows("tasks_tasks")).toBe(2);
  });
});

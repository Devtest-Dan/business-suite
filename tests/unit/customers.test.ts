import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { approve, propose } from "@/lib/approvals/ledger";
import { moduleContext } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { approvalItems, notifications } from "@/lib/db/schema";
import type { ApplyContext, Viewer } from "@/lib/modules/contract";
import { looksLikeCardNumber, luhnValid } from "@/modules/customers/card-guard";
import { csvCell, toCsv } from "@/modules/customers/csv-out";
import {
  deliverDueReminders,
  getContact,
  listContacts,
  listFollowUps,
  listStages,
  saveContact,
  saveDeal,
  searchCustomers,
  timeline,
  todayIn,
  type ContactValues,
} from "@/modules/customers/data";
import { findMatch, mergeContact, nameKey, phoneKey, planMerge } from "@/modules/customers/dedupe";
import { planImport } from "@/modules/customers/import";
import { checkCustomValues, contactInput, noteInput } from "@/modules/customers/schemas";
import { seedExamples } from "@/modules/customers/seed";
import { taskInputFor, taskShapes } from "@/modules/customers/tasks-link";
import { taskInput as tasksCreateInput } from "@/modules/tasks/schemas";
import { countRows, makeUser, resetDb } from "./helpers";

const CUSTOMER_TABLES = "customers_saved_filters, customers_fields, customers_follow_ups, customers_activities, customers_deals, customers_stages, customers_contacts, customers_companies";

async function reset() {
  await db().execute(sql.raw(`truncate table ${CUSTOMER_TABLES} restart identity cascade`));
  await resetDb();
}

const blank: ContactValues = { name: "", email: "", phone: "", jobTitle: "", companyName: "", address: "", notes: "", tags: [], custom: {}, ownerId: null };

async function addContact(by: Viewer, values: Partial<ContactValues>) {
  return saveContact(db(), { ...blank, ...values }, by, null);
}

async function approvalIdOf(csv: string, by: Viewer) {
  const plan = await planImport(db(), csv);
  const result = await propose({ action: "customers.import_contact", items: plan.items, source: "import", requestedBy: by });
  return { plan, result };
}

describe("card numbers are refused", () => {
  it("finds card-like numbers (Luhn-valid, 13 to 19 digits, spaces or dashes allowed)", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(looksLikeCardNumber("4111 1111 1111 1111")).toBe(true);
    expect(looksLikeCardNumber("card: 4242-4242-4242-4242 exp 12/30")).toBe(true);
    expect(looksLikeCardNumber("Amex 378282246310005")).toBe(true);
    expect(looksLikeCardNumber("5555555555554444")).toBe(true);
  });

  it("leaves phone numbers, dates, short and non-Luhn numbers alone", () => {
    expect(looksLikeCardNumber("+1 415 555 0100")).toBe(false);
    expect(looksLikeCardNumber("+44 20 7946 0958 ext 12")).toBe(false);
    expect(looksLikeCardNumber("Order 4111111111111112")).toBe(false); // fails Luhn
    expect(looksLikeCardNumber("Invoice 2026-10-07, 12 items")).toBe(false);
    expect(looksLikeCardNumber("0000 0000 0000 0000")).toBe(false);
    expect(looksLikeCardNumber("1234567890123")).toBe(false); // starts with 1: no card scheme
  });

  it("every free-text field of a contact refuses them", () => {
    const card = "4111 1111 1111 1111";
    for (const field of ["name", "notes", "jobTitle", "address", "companyName"]) {
      const r = contactInput.safeParse({ name: "Jo", [field]: field === "name" ? `Jo ${card}` : card });
      expect(r.success, field).toBe(false);
    }
    expect(contactInput.safeParse({ name: "Jo", tags: [card] }).success).toBe(false);
    expect(contactInput.safeParse({ name: "Jo", custom: { memo: card } }).success).toBe(false);
    expect(contactInput.safeParse({ name: "Jo", phone: "4111 1111 1111 1111" }).success).toBe(false);
    expect(contactInput.safeParse({ name: "Jo", phone: "+1 (415) 555-0100" }).success).toBe(true);
    expect(noteInput.safeParse({ contactId: "00000000-0000-4000-8000-000000000000", body: `paid with ${card}` }).success).toBe(false);
    expect(checkCustomValues([{ key: "memo", label: "Memo", type: "text", options: [] }], { memo: card }).errors.memo).toMatch(/card number/);
  });
});

describe("duplicate detection (pure)", () => {
  const existing = [
    { id: "a", name: "Ana Lima", email: "ana@x.test", phone: "", emailKey: "ana@x.test", phoneKey: "", nameKey: "ana lima" },
    { id: "b", name: "Ben Ode", email: "", phone: "(415) 555-0101", emailKey: "", phoneKey: phoneKey("(415) 555-0101"), nameKey: "ben ode" },
    { id: "c", name: "Cara Diaz", email: "cara@x.test", phone: "", emailKey: "cara@x.test", phoneKey: "", nameKey: "cara diaz" },
  ];

  it("matches by email first, then phone, then name", () => {
    expect(findMatch({ name: "Someone", email: "ANA@x.test ", phone: "" }, existing)).toMatchObject({ by: "email", contact: { id: "a" } });
    expect(findMatch({ name: "B. Ode", email: "", phone: "+1 415 555 0101" }, existing)).toMatchObject({ by: "phone", contact: { id: "b" } });
    expect(findMatch({ name: "Cára  Díaz", email: "", phone: "" }, existing)).toMatchObject({ by: "name", contact: { id: "c" } });
  });

  it("does not match a name when the emails say they are different people", () => {
    expect(findMatch({ name: "Cara Diaz", email: "other@x.test", phone: "" }, existing)).toBeNull();
    expect(nameKey("  Ana-Lima ")).toBe("ana lima");
  });

  it("a merge fills blanks, adds tags and notes, and never overwrites", () => {
    const current = { ...blank, name: "Ana", email: "ana@x.test", tags: ["vip"], notes: "Old note" };
    const incoming = { ...blank, name: "Ana", email: "ana.other@x.test", phone: "555 0100", tags: ["vip", "wholesale"], notes: "New note", custom: {} };
    const plan = planMerge(current, incoming);
    expect(plan).toEqual({ filled: ["phone"], kept: ["email"], tagsAdded: ["wholesale"], notesAppended: true });
    const merged = mergeContact(current, incoming);
    expect(merged.email).toBe("ana@x.test");
    expect(merged.phone).toBe("555 0100");
    expect(merged.tags).toEqual(["vip", "wholesale"]);
    expect(merged.notes).toBe("Old note\n\nNew note");
  });
});

describe("CSV export", () => {
  it("quotes and defuses spreadsheet formulas", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(["a", "b"])).toBe("a; b");
    expect(toCsv(["a", "b"], [[1, null]])).toBe("a,b\r\n1,\r\n");
  });
});

describe("customers (real Postgres)", () => {
  beforeEach(reset, 60_000);

  it("an import is ONE approval, proposes merges, and approving twice writes each row once", async () => {
    const admin = await makeUser("admin", "Ada Admin");
    await addContact(admin, { name: "Ana Lima", email: "ana@x.test", tags: ["vip"] });
    await addContact(admin, { name: "Ben Ode", phone: "415 555 0101" });
    const csv = [
      "Name,Email,Phone,Company,Tags,Notes",
      "Ana Lima,ANA@x.test,555 0100,Riverside,wholesale,Met at the fair", // merge by email
      "Benjamin Ode,,+1 (415) 555-0101,,,", // merge by phone (nothing new → left out)
      "Cara Diaz,cara@x.test,,Hilltop,,", // new
      "Cara Diaz,cara@x.test,555 0199,,,Second row", // same person in the file: combined
      "Dev Card,dev@x.test,,,,4111 1111 1111 1111", // refused: card number
      "Eve New,eve@x.test,,Riverside,,", // new
    ].join("\n");
    const { plan, result } = await approvalIdOf(csv, admin);
    expect(plan.rows).toBe(6);
    expect(plan.creates).toBe(2);
    expect(plan.merges.email).toBe(1);
    expect(plan.upToDate).toBe(1);
    expect(plan.combinedInFile).toBe(1);
    expect(plan.invalid).toEqual([{ row: 6, error: expect.stringMatching(/card number/) }]);
    expect(result.accepted).toBe(3);
    expect(await countRows("approvals")).toBe(1);
    expect(await countRows("customers_contacts")).toBe(2); // nothing written yet

    const first = await approve(result.approvalId!, admin);
    expect(first).toMatchObject({ appliedNow: 3, status: "applied" });
    const again = await approve(result.approvalId!, admin);
    expect(again.appliedNow).toBe(0);
    expect(await countRows("customers_contacts")).toBe(4); // Ana, Ben + Cara, Eve

    const all = await listContacts(await moduleContext("customers", admin), {});
    const ana = all.find((c) => c.name === "Ana Lima")!;
    expect(ana.email).toBe("ana@x.test");
    expect(ana.phone).toBe("555 0100");
    expect(ana.tags).toEqual(["vip", "wholesale"]);
    expect(ana.companyName).toBe("Riverside");
    const cara = all.find((c) => c.name === "Cara Diaz")!;
    expect(cara.phone).toBe("555 0199");
    expect(cara.notes).toBe("Second row");
    expect(all.find((c) => c.name === "Eve New")!.companyId).toBe(ana.companyId); // one company "Riverside"

    const results = await db().select({ result: approvalItems.result }).from(approvalItems).where(eq(approvalItems.approvalId, result.approvalId!));
    const summaries = results.map((r) => (r.result as { summary: string }).summary).sort();
    expect(summaries[0]).toMatch(/^Added Cara Diaz/);
    expect(summaries.some((s) => /^Merged into Ana Lima: fills phone, company; adds tag wholesale; adds to the notes/.test(s))).toBe(true);

    // The same file again: nothing new (the merge is done, the new contacts exist).
    const second = await planImport(db(), csv);
    expect(second.items).toHaveLength(0);
    expect(second.upToDate).toBe(4);
  });

  it("a row proposed as new is merged when that person was added before approval", async () => {
    const admin = await makeUser("admin");
    const { result } = await approvalIdOf("name,email,phone\nZoe Park,zoe@x.test,555 0177", admin);
    await addContact(admin, { name: "Zoe P.", email: "zoe@x.test" });
    await approve(result.approvalId!, admin);
    expect(await countRows("customers_contacts")).toBe(1);
    const [item] = await db().select({ result: approvalItems.result }).from(approvalItems).where(eq(approvalItems.approvalId, result.approvalId!));
    expect((item.result as { summary: string }).summary).toMatch(/Merged into Zoe P\..*added after the import was proposed/);
  });

  it("AI writes only propose; approved, they add a note, move a deal and set a follow-up", async () => {
    const owner = await makeUser("owner", "Olive Owner");
    const member = await makeUser("member", "Max Member");
    const ana = await addContact(owner, { name: "Ana Lima", email: "ana@x.test" });
    const stages = await listStages(db());
    const deal = await saveDeal(db(), { title: "Catering", stageId: stages[0].id, contactId: ana.id, companyId: null, valueCents: 50_000, expectedClose: null, notes: "", custom: {}, ownerId: owner.id }, owner, null);

    const note = await propose({ action: "customers.add_note", items: [{ contactId: ana.id, about: "Ana Lima", kind: "call", body: "Called: she wants Mondays." }], source: "ai", requestedBy: member });
    const move = await propose({ action: "customers.update_deal_stage", items: [{ dealId: deal.id, dealTitle: "Catering", stage: stages[3].name.toUpperCase() }], source: "ai", requestedBy: member });
    const due = todayIn("UTC");
    const follow = await propose({ action: "customers.create_follow_up", items: [{ contactId: ana.id, about: "Ana Lima", title: "Send the menu", dueOn: due }], source: "ai", requestedBy: member });
    expect(await countRows("customers_activities")).toBe(0);
    const [preview] = await db().select({ preview: approvalItems.preview }).from(approvalItems).where(eq(approvalItems.approvalId, note.approvalId!));
    expect(preview.preview).toBe("Add a call to “Ana Lima”: Called: she wants Mondays.");

    for (const a of [note, move, follow]) expect((await approve(a.approvalId!, owner)).status).toBe("applied");
    const events = await timeline(db(), { contactId: ana.id });
    expect(events.map((e) => e.kind).sort()).toEqual(["call", "stage_change"]);
    expect(events.find((e) => e.kind === "call")!.via).toBe("ai");
    expect(events.find((e) => e.kind === "stage_change")!.body).toBe(`Moved from ${stages[0].name} to ${stages[3].name}.`);
    const followUps = await listFollowUps(db(), { contactId: ana.id });
    expect(followUps).toHaveLength(1);
    // With the Tasks app installed, the follow-up becomes a task in "Customer follow-ups" (made on first use).
    expect(followUps[0]).toMatchObject({ title: "Send the menu", via: "tasks" });
    const projects = await db().execute(sql`select p.name, count(t.id)::int as n from tasks_projects p left join tasks_tasks t on t.project_id = p.id where p.name = 'Customer follow-ups' group by p.name`);
    expect((projects as unknown as { rows?: unknown[] }).rows ?? projects).toMatchObject([{ name: "Customer follow-ups", n: 1 }]);

    // A stage that does not exist fails that record with a reason, and writes nothing.
    const bad = await propose({ action: "customers.update_deal_stage", items: [{ dealId: deal.id, stage: "Nowhere" }], source: "ai", requestedBy: member });
    const report = await approve(bad.approvalId!, owner);
    expect(report.status).toBe("failed");
    expect(report.failures[0].error).toMatch(/no stage called “Nowhere”/);
  });

  it("a due reminder is notified once, even when two pages load at once", async () => {
    const member = await makeUser("member");
    const ana = await addContact(member, { name: "Ana" });
    const { insertFollowUp } = await import("@/modules/customers/data");
    await insertFollowUp(db(), { title: "Call Ana", notes: "", dueOn: todayIn("UTC"), contactId: ana.id, companyId: null, dealId: null, assigneeId: member.id }, member);
    await insertFollowUp(db(), { title: "Later", notes: "", dueOn: "2999-01-01", contactId: ana.id, companyId: null, dealId: null, assigneeId: member.id }, member);
    const [a, b] = await Promise.all([deliverDueReminders(db(), member.id, "UTC"), deliverDueReminders(db(), member.id, "UTC")]);
    expect(a + b).toBe(1);
    const sent = await db().select().from(notifications).where(eq(notifications.kind, "customers.follow_up_due"));
    expect(sent.map((n) => n.title)).toEqual(["Due today: Call Ana"]);
  });

  it("seeds clearly invented examples that search finds", async () => {
    const owner = await makeUser("owner");
    const ctx = await moduleContext("customers", owner);
    await seedExamples(ctx);
    const contacts = await listContacts(ctx, { tag: "example" });
    expect(contacts.length).toBeGreaterThanOrEqual(4);
    expect(contacts.every((c) => c.email.endsWith("@example.com"))).toBe(true);
    const hits = await searchCustomers(ctx, "riverside", 10);
    expect(hits[0]).toMatchObject({ title: "Riverside Cafe (example)" });
    expect((await searchCustomers(ctx, "catering", 10)).some((h) => h.url.includes("/deals/"))).toBe(true);
  });

  it("refuses a card number on the way in, even past the form", async () => {
    const owner = await makeUser("owner");
    const r = await propose({ action: "customers.add_note", items: [{ dealId: "00000000-0000-4000-8000-000000000000", body: "Card 4111-1111-1111-1111" }], source: "ai", requestedBy: owner });
    expect(r.approvalId).toBeNull();
    expect(r.invalid[0].error).toMatch(/card number/);
    expect(await countRows("approvals")).toBe(0);
  });
});

describe("the Tasks link", () => {
  it("offers the task in the first shape the Tasks app accepts, or none", () => {
    const draft = { title: "Call back", notes: "About the quote", dueOn: "2026-10-09", assigneeId: null, assigneeEmail: "", about: "Ana", url: "/m/customers/contacts/1" };
    const strict = { fullName: "tasks.create_task", action: { input: z.strictObject({ title: z.string(), dueDate: z.string() }) } } as never;
    expect(taskInputFor(strict, draft)).toEqual({ title: "Call back", dueDate: "2026-10-09" });
    const loose = { fullName: "tasks.create_task", action: { input: z.object({ title: z.string(), description: z.string(), dueDate: z.string() }) } } as never;
    // The first shape is tasks.create_task's own (no dueDate), so a loose schema wanting dueDate takes the next one.
    expect(taskInputFor(loose, draft)).toEqual(taskShapes(draft)[1]);
    const needsProject = { fullName: "tasks.create_task", action: { input: z.object({ title: z.string(), projectId: z.string().uuid() }) } } as never;
    expect(taskInputFor(needsProject, draft)).toBeNull();
  });

  it("matches the real Tasks app input exactly: project made on first use, source shown", () => {
    const draft = { title: "Call back", notes: "About the quote", dueOn: "2026-10-09", assigneeId: null, assigneeEmail: "sam@example.com", about: "Ana", url: "/m/customers/contacts/1" };
    const real = { fullName: "tasks.create_task", action: { input: tasksCreateInput } } as never;
    const input = taskInputFor(real, draft) as Record<string, unknown>;
    expect(input).toMatchObject({ project: "Customer follow-ups", createProjectIfMissing: true, title: "Call back", dueOn: "2026-10-09", assignees: ["sam@example.com"], sourceUrl: "/m/customers/contacts/1" });
    expect(tasksCreateInput.safeParse(input).success).toBe(true);
  });

  it("an approved follow-up becomes a task through the Tasks app's write action when it is on", async () => {
    await reset();
    const owner = await makeUser("owner");
    const ana = await addContact(owner, { name: "Ana" });
    const apply = vi.fn(async () => ({ targetId: "task-42", summary: "Added task" }));
    vi.doMock("@/modules/customers/tasks-link", async (orig) => ({
      ...(await orig<typeof import("@/modules/customers/tasks-link")>()),
      tasksLink: async () => ({ fullName: "tasks.create_task", action: { name: "create_task", permission: "customers.edit", input: z.object({ title: z.string(), dueDate: z.string() }), apply } }),
    }));
    vi.resetModules();
    const { applyFollowUp } = await import("@/modules/customers/follow-ups");
    const { followUpInput } = await import("@/modules/customers/schemas");
    const input = followUpInput.parse({ contactId: ana.id, title: "Send the menu", dueOn: "2026-10-09" });
    const summary = await db().transaction((tx) =>
      applyFollowUp({ tx, moduleId: "customers", approvalId: "00000000-0000-4000-8000-000000000001", source: "ai", dedupeKey: "k1", approver: owner, requestedBy: owner, business: { name: "B", timezone: "UTC" } } as ApplyContext, input),
    );
    vi.doUnmock("@/modules/customers/tasks-link");
    expect(apply).toHaveBeenCalledTimes(1);
    expect((apply.mock.calls[0] as unknown[])[1]).toEqual({ title: "Send the menu", dueDate: "2026-10-09" });
    expect(summary.summary).toMatch(/Added the task “Send the menu” in Tasks/);
    const [row] = await listFollowUps(db(), { contactId: ana.id });
    expect(row).toMatchObject({ via: "tasks", taskId: "task-42" });
    expect((await getContact(db(), ana.id))?.name).toBe("Ana");
  });
});


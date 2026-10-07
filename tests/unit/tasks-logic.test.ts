import { describe, expect, it } from "vitest";
import { ahlDedupeKey, ahlRecordsToInputs, csvToTaskRecords, parseAhlExport } from "@/modules/tasks/imports";
import {
  addDays,
  daysBetween,
  describeDue,
  dueState,
  findMentions,
  isIsoDate,
  isSafeSuitePath,
  mentionsEveryone,
  monthGrid,
  nextDueDate,
  nextOccurrence,
  parseLabels,
  positionAt,
  shiftMonth,
  todayIn,
} from "@/modules/tasks/logic";
import { taskInput } from "@/modules/tasks/schemas";

describe("tasks: dates", () => {
  it("checks real dates", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-1-5")).toBe(false);
  });

  it("knows today in the business's timezone", () => {
    const now = new Date("2026-10-07T03:30:00Z");
    expect(todayIn("UTC", now)).toBe("2026-10-07");
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-10-06");
    expect(todayIn("Asia/Kolkata", now)).toBe("2026-10-07");
    expect(todayIn("Not/AZone", now)).toBe("2026-10-07");
  });

  it("adds days and counts them across month and year ends", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(daysBetween("2026-10-01", "2026-10-15")).toBe(14);
    expect(daysBetween("2026-10-15", "2026-10-01")).toBe(-14);
  });

  it("repeats daily, on weekdays, weekly, monthly (clamped) and yearly", () => {
    expect(nextOccurrence("2026-10-07", "daily")).toBe("2026-10-08");
    expect(nextOccurrence("2026-10-09", "weekdays")).toBe("2026-10-12"); // Friday → Monday
    expect(nextOccurrence("2026-10-07", "weekly")).toBe("2026-10-14");
    expect(nextOccurrence("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextOccurrence("2028-01-31", "monthly")).toBe("2028-02-29");
    expect(nextOccurrence("2028-02-29", "yearly")).toBe("2029-02-28");
  });

  it("never makes a repeat that is already overdue", () => {
    expect(nextDueDate("2026-10-01", "weekly", "2026-10-02")).toBe("2026-10-08");
    expect(nextDueDate("2026-09-01", "weekly", "2026-10-07")).toBe("2026-10-13");
    expect(nextDueDate(null, "daily", "2026-10-07")).toBe("2026-10-08");
    expect(nextDueDate("2026-10-01", "none", "2026-10-07")).toBeNull();
  });

  it("describes due dates plainly", () => {
    expect(describeDue("2026-10-07", "2026-10-07")).toBe("Due today");
    expect(describeDue("2026-10-08", "2026-10-07")).toBe("Due tomorrow");
    expect(describeDue("2026-10-06", "2026-10-07")).toBe("1 day late");
    expect(describeDue("2026-10-02", "2026-10-07")).toBe("5 days late");
    expect(describeDue("2026-10-20", "2026-10-07")).toBe("Due Oct 20");
    expect(dueState("2026-10-01", "2026-10-07")).toBe("overdue");
    expect(dueState("2026-10-01", "2026-10-07", true)).toBe("none");
  });

  it("lays out a month Monday first", () => {
    const weeks = monthGrid("2026-10");
    expect(weeks[0][0]).toBe("2026-09-28");
    expect(weeks.at(-1)![6]).toBe("2026-11-01");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
});

describe("tasks: mentions, labels, positions, links", () => {
  const people = [
    { id: "1", name: "Sam Lee" },
    { id: "2", name: "Sam Patel" },
    { id: "3", name: "Priya Shah" },
  ];
  it("finds @Full Name, and @First only when it is unique", () => {
    expect(findMentions("Thanks @Priya, and @Sam Lee please check", people).sort()).toEqual(["1", "3"]);
    expect(findMentions("@sam can you look", people)).toEqual([]);
    expect(findMentions("email priya@example.com", people)).toEqual([]);
    expect(findMentions("@Priyanka is someone else", people)).toEqual([]);
    expect(mentionsEveryone("heads up @everyone")).toBe(true);
  });

  it("cleans labels", () => {
    expect(parseLabels("Urgent, shop;  Shop , ,front")).toEqual(["Urgent", "shop", "front"]);
    expect(parseLabels(Array.from({ length: 15 }, (_, i) => `l${i}`))).toHaveLength(10);
  });

  it("places a dropped card between its neighbours", () => {
    expect(positionAt([], 0)).toBe(1);
    expect(positionAt([1, 2, 3], 0)).toBe(0);
    expect(positionAt([1, 2, 3], 3)).toBe(4);
    expect(positionAt([1, 2, 3], 1)).toBe(1.5);
    expect(positionAt([1, 2, 3], 99)).toBe(4);
  });

  it("only links back inside the suite", () => {
    expect(isSafeSuitePath("/m/chat/abc")).toBe(true);
    expect(isSafeSuitePath("//evil.example")).toBe(false);
    expect(isSafeSuitePath("https://evil.example")).toBe(false);
    expect(isSafeSuitePath("/x\\y")).toBe(false);
    expect(taskInput.safeParse({ project: "P", title: "T", sourceUrl: "javascript:alert(1)" }).success).toBe(false);
  });
});

describe("tasks: the AHL Tasks export (v1)", () => {
  const file = {
    format: "business-suite.tasks",
    version: 1,
    exportedAt: "2026-10-07T12:00:00.000Z",
    business: { name: "Rivera Plumbing" },
    tasks: [
      {
        externalId: "6f1c0e8a-0d5b-4c2e-9a41-2f7d3b1e9c10",
        title: "Share a safe sample of the data",
        detail: "Twenty past quotes.",
        status: "todo",
        assignee: "owner",
        dueOn: null,
        source: { kind: "proposal", label: "Proposal: Quote drafts", ref: "1d2e", position: 1 },
        createdAt: "2026-10-07T10:00:00.000Z",
        updatedAt: "2026-10-07T10:00:00.000Z",
        somethingNew: "ignored",
      },
      { externalId: "b", title: "Book the intern's first call", status: "doing", assignee: "intern", dueOn: "2026-10-20", updatedAt: "2026-10-07T11:00:00Z" },
      { externalId: "c", title: "", status: "todo", updatedAt: "2026-10-07T11:00:00Z" },
    ],
  };

  it("reads the documented shape, ignores unknown fields and reports bad tasks", () => {
    const parsed = parseAhlExport(JSON.stringify(file));
    expect(parsed.businessName).toBe("Rivera Plumbing");
    expect(parsed.tasks.map((t) => t.externalId)).toEqual(["6f1c0e8a-0d5b-4c2e-9a41-2f7d3b1e9c10", "b"]);
    expect(parsed.invalid).toHaveLength(1);
    expect(parsed.invalid[0].index).toBe(2);
    expect("somethingNew" in parsed.tasks[0]).toBe(false);
  });

  it("refuses another format, another version, and broken JSON, saying what to do", () => {
    expect(() => parseAhlExport(JSON.stringify({ ...file, format: "other" }))).toThrow(/not a Tasks export/);
    expect(() => parseAhlExport(JSON.stringify({ ...file, version: 2 }))).toThrow(/version this suite cannot read/);
    expect(() => parseAhlExport("{not json")).toThrow(/not valid JSON/);
  });

  it("maps owner and intern to the people chosen, and keys each task by externalId and updatedAt", () => {
    const parsed = parseAhlExport(JSON.stringify(file));
    const inputs = ahlRecordsToInputs(parsed.tasks, { projectId: "p", ownerId: "owner-id", internId: "intern-id" });
    expect(inputs[0].assigneeId).toBe("owner-id");
    expect(inputs[1].assigneeId).toBe("intern-id");
    expect(inputs[0].sourceLabel).toBe("Proposal: Quote drafts");
    expect(ahlDedupeKey(inputs[1])).toBe("ahl:b:2026-10-07T11:00:00.000Z");
  });
});

describe("tasks: CSV import rows", () => {
  it("turns rows into create_task records with keys", () => {
    const csv = "title,status,priority,due,assignees,labels,checklist,key\nOrder rolls,In progress,High,2026-11-02,a@x.test;Sam Lee,shop;Shop,one;two,k1\nPlain,,,,,,,";
    const { records, keys } = csvToTaskRecords(csv, "proj");
    expect(records[0]).toMatchObject({ project: "proj", title: "Order rolls", status: "doing", priority: "high", dueOn: "2026-11-02", assignees: ["a@x.test", "Sam Lee"], labels: ["shop"], checklist: ["one", "two"] });
    expect(keys).toEqual(["csv:proj:k1", null]);
    expect(taskInput.safeParse(records[1]).success).toBe(true);
  });

  it("asks for a title column", () => {
    expect(() => csvToTaskRecords("name\nx", "p")).toThrow(/title/);
  });
});

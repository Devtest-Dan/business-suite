import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { converse, toolsFor } from "@/lib/ai/assistant";
import type { ResolvedAi } from "@/lib/ai/client";
import { approve } from "@/lib/approvals/ledger";
import { db } from "@/lib/db/client";
import { createProject, createTask } from "@/modules/tasks/data";
import { addDays, todayIn } from "@/modules/tasks/logic";
import { countRows, makeUser, resetDb } from "./helpers";

/** The tasks AI tools inside the real assistant loop, against a local stand-in for the provider's API. */
type Reply = (body: Record<string, unknown>) => unknown;
let server: Server;
let base = "";
let replies: Reply[] = [];
let seen: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    seen.push(body);
    const next = replies.shift();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(next ? next(body) : { content: [{ type: "text", text: "no reply queued" }], stop_reason: "end_turn" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(async () => {
  await resetDb();
  replies = [];
  seen = [];
});

const ai = (): ResolvedAi => ({ provider: "anthropic", baseUrl: `${base}/anthropic`, model: "deepseek-flash", apiKey: "sk-test", maxTokens: 1000, redact: false });

describe("tasks AI tools", () => {
  it("offers read and write tools to people who may use them, and none to guests' write side", async () => {
    const owner = await makeUser("owner");
    const guest = await makeUser("guest");
    const ownerTools = (await toolsFor(owner)).map((t) => t.spec.name);
    expect(ownerTools).toEqual(expect.arrayContaining(["list_projects", "list_tasks", "find_tasks", "overdue_tasks", "create_task", "create_tasks", "update_task_status", "update_task_statuses"]));
    const guestTools = (await toolsFor(guest)).map((t) => t.spec.name);
    expect(guestTools).not.toContain("create_tasks");
  });

  it("overdue_tasks runs at once; create_tasks makes ONE approval that writes each task once", async () => {
    const owner = await makeUser("owner", "Olive Owner");
    const p = await createProject(db(), { name: "Shop", description: "", visibility: "team" }, owner);
    await createTask(db(), { projectId: p.id, title: "Pay the window cleaner", dueOn: addDays(todayIn("UTC"), -1), assigneeIds: [owner.id] }, owner);
    replies = [
      () => ({ content: [{ type: "tool_use", id: "toolu_r", name: "overdue_tasks", input: { mineOnly: true } }], stop_reason: "tool_use" }),
      () => ({
        content: [
          {
            type: "tool_use",
            id: "toolu_w",
            name: "create_tasks",
            input: { items: [{ project: "Shop", title: "Book the cleaner for next month" }, { project: "Shop", title: "Ask for a regular slot", assignees: ["Olive Owner"] }] },
          },
        ],
        stop_reason: "tool_use",
      }),
      () => ({ content: [{ type: "text", text: "One task is overdue. I drafted two follow-ups; they wait in Approvals." }], stop_reason: "end_turn" }),
    ];
    const history = await converse(owner, [], "What is overdue, and plan the follow-up?", ai());
    expect(JSON.stringify(seen[1].messages)).toContain("Pay the window cleaner");
    expect(await countRows("approvals")).toBe(1);
    expect(await countRows("approval_items")).toBe(2);
    expect(await countRows("tasks_tasks")).toBe(1);
    const approvalId = history.flatMap((m) => m.meta?.approvals ?? [])[0].id;
    await approve(approvalId, owner);
    await approve(approvalId, owner);
    expect(await countRows("tasks_tasks")).toBe(3);
  });
});

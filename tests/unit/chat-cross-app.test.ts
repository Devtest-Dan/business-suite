import { describe, expect, it } from "vitest";
import { CHAT_TASK_PROJECT, findTarget, payloadFor, titleFrom, type MessageForApps } from "@/modules/chat/cross-app";
import { createPageInput } from "@/modules/docs/schemas";
import { modules } from "@/modules/registry";
import { taskInput } from "@/modules/tasks/schemas";

const message: MessageForApps = {
  title: "Order more flour before Friday",
  body: "Order more flour before Friday\nThe 25 kg bags, not the small ones.",
  authorName: "Sam Baker",
  conversation: "#kitchen",
  date: "2026-10-07",
  path: "/m/chat/0b7f6d1e-5c4b-4a39-9d2e-3f1a2b3c4d5e/thread/1c8f6d1e-5c4b-4a39-9d2e-3f1a2b3c4d5e?m=2d9f6d1e-5c4b-4a39-9d2e-3f1a2b3c4d5e",
  url: "http://localhost:3000/m/chat/0b7f6d1e-5c4b-4a39-9d2e-3f1a2b3c4d5e/thread/1c8f6d1e-5c4b-4a39-9d2e-3f1a2b3c4d5e?m=2d9f6d1e-5c4b-4a39-9d2e-3f1a2b3c4d5e",
};

describe("chat's cross-app writes use the real Tasks and Docs actions", () => {
  it("finds tasks.create_task and docs.create_page in the installed apps, and nothing when they are off", () => {
    expect(findTarget("task", modules)?.action.name).toBe("create_task");
    expect(findTarget("doc", modules)?.action.name).toBe("create_page");
    expect(findTarget("task", modules.filter((m) => m.id !== "tasks"))).toBeNull();
    expect(findTarget("doc", modules.filter((m) => m.id !== "docs"))).toBeNull();
  });

  it("a task payload parses against the Tasks input schema, filed in 'From chat' with a link back", () => {
    const parsed = taskInput.parse(payloadFor("task", message));
    expect(parsed).toMatchObject({
      project: CHAT_TASK_PROJECT,
      createProjectIfMissing: true,
      title: "Order more flour before Friday",
      sourceLabel: "From chat: #kitchen",
      sourceUrl: message.path,
    });
    expect(parsed.description).toContain("The 25 kg bags");
    expect(parsed.description).toContain("— Sam Baker in #kitchen, 2026-10-07");
    // The manifest's own action schema is the one propose() runs.
    expect(findTarget("task", modules)!.action.input.safeParse(payloadFor("task", message)).success).toBe(true);
  });

  it("a docs payload parses against the Docs input schema", () => {
    const parsed = createPageInput.parse(payloadFor("doc", message));
    expect(parsed).toMatchObject({ title: "Order more flour before Friday", kind: "page", note: "From chat: #kitchen" });
    expect(parsed.body).toContain(`[Open the message in chat](${message.url})`);
    expect(findTarget("doc", modules)!.action.input.safeParse(payloadFor("doc", message)).success).toBe(true);
  });

  it("long messages are cut to what the other apps accept", () => {
    const long = { ...message, title: "t".repeat(500), body: "b".repeat(20_000), conversation: "c".repeat(300) };
    expect(taskInput.safeParse(payloadFor("task", long)).success).toBe(true);
    expect(createPageInput.safeParse(payloadFor("doc", long)).success).toBe(true);
  });

  it("titles come from the first non-empty line", () => {
    expect(titleFrom("\n  First line  \nsecond", "x")).toBe("First line");
    expect(titleFrom("   ", "Message from Sam")).toBe("Message from Sam");
  });
});

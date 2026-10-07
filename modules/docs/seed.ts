import "server-only";
import type { ModuleContext } from "@/lib/modules/contract";
import { createPage, createSpace } from "./data";
import { docsSpaces } from "./schema";

/**
 * Demo content for a new suite. Everything here is an invented example,
 * labelled "(example)" so nobody mistakes it for the business's own rules.
 * It runs once, when the owner finishes setup or switches Docs on.
 */
export async function seedDocs(ctx: ModuleContext): Promise<void> {
  const existing = await ctx.db.select({ id: docsSpaces.id }).from(docsSpaces).limit(1);
  if (existing.length) return;
  await ctx.db.transaction(async (tx) => {
    const space = await createSpace(
      tx,
      {
        name: "Handbook",
        description: "How we do things here. The pages marked (example) are invented examples to show what Docs can do: edit them into your own, or archive them.",
        visibility: "team",
      },
      ctx.viewer,
    );
    const page = (title: string, body: string, extra: Partial<Parameters<typeof createPage>[1]> = {}) =>
      createPage(
        tx,
        { spaceId: space.id, title, body, kind: "page", steps: [], schedule: "none", scheduleDay: null, isTemplate: false, note: "Example content", ...extra },
        ctx.viewer,
      );

    const start = await page(
      "Start here (example)",
      [
        `This is ${ctx.business.name}'s handbook: the place for how things are done, written down once so nobody has to ask twice.`,
        "",
        "## What is in it",
        "",
        "- **Pages** like this one, written in Markdown. Link to another page by putting its title in double square brackets, like [[Opening checklist (example)]].",
        "- **Procedures**: numbered steps someone works through. Press “Run this procedure” on one to get a checklist that records who did each step and when.",
        "- **Templates** for pages you write again and again, such as meeting notes.",
        "",
        "## Tips",
        "",
        "1. Every save keeps the earlier version: open **History** on any page to compare or bring one back.",
        "2. The assistant can draft a page or a change, but nothing is saved until someone approves it in **Approvals**.",
        "3. Make a private space for things only some people should see (for example, management notes).",
      ].join("\n"),
    );

    await page(
      "Opening checklist (example)",
      "What the first person in does every morning, before the doors open. Run it from this page each day; the record shows who opened and what they found.",
      {
        parentId: start.id,
        kind: "procedure",
        schedule: "daily",
        steps: [
          { text: "Turn off the alarm and switch on the lights", note: "", check: "none", checkLabel: "" },
          { text: "Check the fridge thermometer", note: "It should read 5 °C or lower. If not, move stock to the back fridge and tell the manager.", check: "yesno", checkLabel: "Is the fridge at 5 °C or lower?" },
          { text: "Count the till float", note: "", check: "value", checkLabel: "Float counted (amount)" },
          { text: "Unlock the front door and turn the sign to Open", note: "", check: "none", checkLabel: "" },
        ],
      },
    );

    await page("Closing checklist (example)", "What the last person out does at the end of the day.", {
      parentId: start.id,
      kind: "procedure",
      schedule: "weekdays",
      steps: [
        { text: "Cash up the till and put the takings in the safe", note: "", check: "value", checkLabel: "Takings counted (amount)" },
        { text: "Switch off the coffee machine and the ovens", note: "", check: "none", checkLabel: "" },
        { text: "Check the back door is locked", note: "", check: "yesno", checkLabel: "Is the back door locked?" },
        { text: "Set the alarm and lock the front door", note: "", check: "none", checkLabel: "" },
      ],
    });

    await page(
      "New starter onboarding (example)",
      "Run this when someone joins. Assign the run to the person showing them around.",
      {
        parentId: start.id,
        kind: "procedure",
        steps: [
          { text: "Invite them to the suite from People", note: "", check: "none", checkLabel: "" },
          { text: "Walk them through [[Start here (example)]] and the opening checklist", note: "", check: "none", checkLabel: "" },
          { text: "Show them the fire exits and the first-aid kit", note: "", check: "yesno", checkLabel: "Shown the fire exits and first-aid kit?" },
          { text: "Agree their first week's shifts", note: "", check: "none", checkLabel: "" },
        ],
      },
    );

    await page(
      "Meeting notes (template)",
      ["**Date:**", "**Who was there:**", "", "## Agenda", "", "1. ", "", "## Decisions", "", "- ", "", "## Actions", "", "- [ ] Who does what, by when"].join("\n"),
      { isTemplate: true },
    );
    await page("Procedure (template)", "What this procedure is for, and when to run it.", {
      isTemplate: true,
      kind: "procedure",
      steps: [
        { text: "First step", note: "", check: "none", checkLabel: "" },
        { text: "A step that asks a question", note: "", check: "yesno", checkLabel: "Is everything as it should be?" },
      ],
    });
  });
}

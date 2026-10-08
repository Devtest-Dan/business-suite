import { expect, test, type Page } from "@playwright/test";
import { startStandInModel } from "./stand-in-model";

/**
 * The Assistant app's main path: what the assistant knows (add, correct,
 * history), a chat turn that recalls a fact (tools shown), a write the
 * assistant proposes that waits in Approvals and is written on approval,
 * the owner's monthly limit pausing the assistant, and an AHL memory export
 * imported as ONE approval. The model is a local stand-in (no API key here).
 * With SUITE_E2E_BRAIN_URL set, the same path runs against a real brain and
 * also creates a coding-agent token.
 *
 * Runs after smoke.spec.ts (it signs in as the owner that spec created) or on
 * its own (it then does the first-run setup itself).
 */

const run = process.env.SUITE_E2E_RUN ?? Date.now().toString(36);
const owner = { name: "Olive Owner", email: "owner@example.test", password: "owner password long enough" };

async function signInOrSetUp(page: Page) {
  await page.goto("/");
  if (page.url().endsWith("/setup")) {
    await page.getByLabel("Business name").fill(`Acme Bakery ${run}`);
    await page.getByLabel("Your name").fill(owner.name);
    await page.getByLabel("Email").fill(owner.email);
    await page.locator('input[name="password"]').fill(owner.password);
    await page.locator('input[name="confirm"]').fill(owner.password);
    await page.getByRole("button", { name: "Create the owner account" }).click();
  } else if (page.url().includes("/sign-in")) {
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  // Setup also seeds every app (and, with a brain, writes the demo facts to it): allow for a first compile.
  await expect(page.getByRole("heading", { name: /^Hello,/ })).toBeVisible({ timeout: 60_000 });
}

async function ask(page: Page, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("conversation")).toContainText(text);
}

test("assistant: facts, a recalled answer, an approved fact, the monthly limit, and an import", async ({ page }) => {
  const model = await startStandInModel();
  try {
    await signInOrSetUp(page);

    // What the assistant knows: the seed's invented examples are there, labelled.
    await page.goto("/m/assistant/facts");
    await expect(page.getByTestId("brain-status")).toBeVisible();
    await expect(page.getByTestId("facts")).toContainText("Example (invented)");

    // Add a fact, then correct it: the earlier wording is kept.
    await page.getByLabel("The fact, in plain words").fill(`Deliveries ${run} come on Tuesdays before 10:00.`);
    await page.getByRole("button", { name: "Remember this" }).click();
    await expect(page.getByRole("status")).toContainText("Remembered.");
    await page.getByTestId("facts").getByText(`Deliveries ${run} come on Tuesdays before 10:00.`).click();
    await page.getByLabel("New wording").fill(`Deliveries ${run} come on Tuesdays before 9:30.`);
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect(page.getByTestId("fact-text")).toHaveText(`Deliveries ${run} come on Tuesdays before 9:30.`);
    await expect(page.getByTestId("fact-history")).toContainText("before 10:00");

    // Point the AI at the stand-in model.
    await page.goto("/settings/ai");
    await page.locator('select[name="provider"]').selectOption("anthropic");
    await page.locator('input[name="baseUrl"]').fill(model.url);
    await page.locator('input[name="model"]').fill("stand-in");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    // The shell's Assistant link opens this app's chat.
    await page.goto("/assistant");
    await expect(page).toHaveURL(/\/m\/assistant$/);

    // A question: the assistant recalls the fact and shows which tool it used.
    await ask(page, "What do we know about deliveries?");
    await expect(page.getByTestId("tools-used").first()).toContainText("recall_business_memory");
    await expect(page.getByTestId("conversation")).toContainText("before 9:30");

    // A write: the assistant proposes a fact; nothing is stored until approved.
    await ask(page, `Remember that the shop ${run} closes at 16:00 on Saturdays.`);
    const held = page.getByTestId("held-for-approval");
    await expect(held).toContainText("Held for approval: Remember a fact (1 record)");
    const chatUrl = page.url();
    await page.goto("/m/assistant/facts");
    await expect(page.getByTestId("facts")).not.toContainText(`shop ${run} closes`);
    await page.goto(chatUrl);
    await page.getByTestId("held-for-approval").getByRole("link", { name: "Open it" }).click();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByTestId("approval-outcome")).toHaveText("1 record written.");
    await page.goto("/m/assistant/facts");
    await expect(page.getByTestId("facts")).toContainText(`the shop ${run} closes at 16:00 on Saturdays.`);
    await expect(page.getByTestId("facts")).toContainText("Proposed by the assistant, approved");

    // The monthly limit: a token limit below this month's use pauses the assistant.
    await page.goto("/m/assistant/settings");
    await expect(page.getByTestId("usage")).toContainText("model call");
    await page.getByLabel("Token limit per month (input + output, whole team)").fill("1");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved. The limits apply")).toBeVisible();
    await page.goto("/m/assistant");
    await expect(page.getByTestId("limit-reached")).toBeVisible();
    await expect(page.getByLabel("Message")).toHaveCount(0);
    await page.goto("/m/assistant/settings");
    await page.getByLabel("Token limit per month (input + output, whole team)").fill("");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved. The limits apply")).toBeVisible();

    // Bring the brain home: an AHL export is ONE approval; withdrawn facts stay out.
    const exported = {
      format: "ahl-business-memory",
      version: 1,
      exportedAt: "2026-10-07T12:00:00.000Z",
      business: { name: "Acme Bakery" },
      facts: [
        { id: `f_${run}_1`, text: `Wholesale orders ${run} need two days' notice.`, kind: "fact", source: "interview", status: "active", updatedAt: "2026-10-01T10:00:00Z", history: [] },
        { id: `f_${run}_2`, text: `The owner ${run} prefers texts to calls.`, kind: "preference", source: "owner", status: "corrected", updatedAt: "2026-10-02T10:00:00Z", history: [{ text: "The owner prefers email.", at: "2026-09-30T10:00:00Z", by: "interview" }] },
        { id: `f_${run}_3`, text: `Withdrawn ${run}.`, kind: "fact", source: "brief", status: "withdrawn", updatedAt: "2026-10-03T10:00:00Z", history: [] },
      ],
    };
    await page.goto("/m/assistant/import");
    await page.getByLabel("The export file (.json)").setInputFiles({ name: "memory.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
    await page.getByRole("button", { name: "Send for approval" }).click();
    await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
    await expect(page.getByText("1 withdrawn fact was left out")).toBeVisible();
    await page.getByRole("button", { name: "Approve all 2" }).click();
    await expect(page.getByTestId("approval-outcome")).toHaveText("2 records written.");
    await page.goto(`/m/assistant/facts?q=${run}`);
    await expect(page.getByTestId("facts")).toContainText(`Wholesale orders ${run}`);
    await expect(page.getByTestId("facts")).not.toContainText(`Withdrawn ${run}.`);

    // The same export again: nothing new to approve.
    await page.goto("/m/assistant/import");
    await page.getByLabel("Or paste its contents").fill(JSON.stringify(exported));
    await page.getByRole("button", { name: "Send for approval" }).click();
    await expect(page.locator(".notice-error")).toContainText("nothing new to approve");

    // With a real brain: a coding agent's token, shown once with its setup lines.
    if (process.env.SUITE_E2E_BRAIN_URL) {
      await page.goto("/m/assistant/agents");
      await page.getByLabel("Name this access").fill(`Claude Code ${run}`);
      await page.getByRole("button", { name: "Create an access token" }).click();
      await expect(page.getByTestId("new-token")).toContainText("claude mcp add --transport http business-brain");
      await page.reload();
      await expect(page.getByTestId("agent-list")).toContainText(`Claude Code ${run}`);
    }
  } finally {
    await model.close();
  }
});

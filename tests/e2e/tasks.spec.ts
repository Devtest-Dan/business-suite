import { expect, test, type Page } from "@playwright/test";

/**
 * Tasks, end to end: the seeded example project, a new project with tasks,
 * the board (drag and drop, and the "Move to" menu), a task's checklist,
 * comment and repeat, the calendar, and an AHL "Tasks" export imported as ONE
 * approval that writes each task once and refuses the same file again.
 *
 * Runs on its own on a fresh database (it does the first-run setup) or after
 * smoke.spec.ts in the same run (it signs in as the same owner).
 */

const run = (process.env.SUITE_E2E_RUN ??= Date.now().toString(36));
const owner = { name: "Olive Owner", email: "owner@example.test", password: "owner password long enough" };

async function ownerSession(page: Page) {
  await page.goto("/");
  if (page.url().endsWith("/setup")) {
    const code = process.env.SUITE_E2E_SETUP_CODE;
    if (code) await page.getByLabel("Setup code").fill(code);
    await page.getByLabel("Business name").fill(`Acme Bakery ${run}`);
    await page.getByLabel("Your name").fill(owner.name);
    await page.getByLabel("Email").fill(owner.email);
    await page.locator('input[name="password"]').fill(owner.password);
    await page.locator('input[name="confirm"]').fill(owner.password);
    await page.getByRole("button", { name: "Create the owner account" }).click();
  } else if (page.url().endsWith("/sign-in")) {
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("heading", { name: /^Hello,/ })).toBeVisible();
}

function exportFile(updatedAt: string) {
  return JSON.stringify({
    format: "business-suite.tasks",
    version: 1,
    exportedAt: updatedAt,
    business: { name: `Rivera Plumbing ${run}` },
    tasks: [
      {
        externalId: `00000000-0000-4000-8000-${run.padStart(12, "0").slice(-12)}`,
        title: `Share a safe sample ${run}`,
        detail: "Twenty past quotes as a spreadsheet export, with customer names replaced.",
        status: "todo",
        assignee: "owner",
        dueOn: null,
        source: { kind: "proposal", label: "Proposal: Quote drafts", ref: null, position: 1 },
        createdAt: updatedAt,
        updatedAt,
      },
      {
        externalId: `11111111-0000-4000-8000-${run.padStart(12, "0").slice(-12)}`,
        title: `Book the intern's first call ${run}`,
        detail: "",
        status: "doing",
        assignee: "intern",
        dueOn: "2026-10-20",
        source: { kind: "advisor_note", label: "Operations advisor note", ref: null, position: 1 },
        createdAt: updatedAt,
        updatedAt,
      },
    ],
  });
}

test("tasks: project, board, task details, calendar, and the AHL import as one approval", async ({ page }) => {
  await ownerSession(page);

  // The seed: clearly labelled example data, and the widget on the home page.
  await expect(page.getByTestId("tasks-widget")).toBeVisible();
  await page.goto("/m/tasks/projects");
  await expect(page.getByTestId("project-list").getByText("Example: Shop window refresh")).toBeVisible();

  // A new project with two tasks.
  await page.getByRole("link", { name: "New project" }).click();
  await page.getByLabel("Name").fill(`Launch ${run}`);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: `Launch ${run}` })).toBeVisible();
  const projectUrl = page.url();
  for (const title of [`Print flyers ${run}`, `Call the radio station ${run}`]) {
    await page.getByLabel("New task").fill(title);
    await page.getByLabel("Assign to").selectOption({ label: owner.name });
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByTestId("project-tasks").getByText(title)).toBeVisible();
  }

  // The board: drag one card to Doing, move the other to Waiting with its menu.
  await page.getByRole("link", { name: "Board", exact: true }).click();
  const todo = page.getByTestId("column-todo");
  const doing = page.getByTestId("column-doing");
  await expect(todo.getByTestId("board-card")).toHaveCount(2);
  const dragSaved = page.waitForResponse((r) => r.request().method() === "POST");
  await todo.getByTestId("board-card").filter({ hasText: `Print flyers ${run}` }).dragTo(doing);
  await expect(doing.getByText(`Print flyers ${run}`)).toBeVisible();
  await dragSaved;
  const menuSaved = page.waitForResponse((r) => r.request().method() === "POST");
  await page.getByLabel(`Move “Call the radio station ${run}” to`).selectOption("waiting");
  await expect(page.getByTestId("column-waiting").getByText(`Call the radio station ${run}`)).toBeVisible();
  await menuSaved;
  await page.reload();
  await expect(page.getByTestId("column-doing").getByText(`Print flyers ${run}`)).toBeVisible();
  await expect(page.getByTestId("column-waiting").getByText(`Call the radio station ${run}`)).toBeVisible();

  // A task: checklist, comment, make it repeat weekly with a due date, then finish it.
  await page.getByRole("link", { name: `Print flyers ${run}` }).click();
  await expect(page.getByTestId("task-title")).toHaveText(`Print flyers ${run}`);
  await page.getByPlaceholder("Add a checklist item").fill("Proof the design");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("checklist").getByText("Proof the design")).toBeVisible();
  await page.getByRole("button", { name: "Tick: Proof the design" }).click();
  await expect(page.getByRole("button", { name: "Untick: Proof the design" })).toBeVisible();
  await page.getByLabel("Add a comment").fill("Draft is on the shared drive.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByTestId("comments").getByText("Draft is on the shared drive.")).toBeVisible();
  await page.getByText("Edit task").click();
  const today = new Date().toISOString().slice(0, 10);
  await page.getByLabel("Due date", { exact: true }).fill(today);
  await page.locator(`select[name="recurrence"]`).selectOption("weekly");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("task-history").getByText("It now repeats (weekly).")).toBeVisible();
  await page.getByTestId("status-buttons").getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".notice-ok").filter({ hasText: "It repeats: the next copy is" })).toBeVisible();

  // The calendar shows the next copy.
  await page.goto("/m/tasks/calendar");
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await page.goto(`${projectUrl}/board`);
  await expect(page.getByTestId("column-todo").getByText(`Print flyers ${run}`)).toBeVisible();

  // The AHL export: ONE approval for the file; approve; the same file again adds nothing.
  await page.goto("/m/tasks/import");
  await page.getByLabel("Project").first().selectOption("new");
  await page.getByLabel("Name of the new project (optional)").fill(`Steps ${run}`);
  await page.getByLabel("…or paste its contents").fill(exportFile("2026-10-07T10:00:00.000Z"));
  await page.getByRole("button", { name: "Send for approval" }).first().click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("approval-items").getByRole("row")).toHaveCount(3); // header + 2
  await page.getByRole("button", { name: "Approve all 2" }).click();
  await expect(page.getByTestId("approval-outcome")).toHaveText("2 records written.");

  await page.goto("/m/tasks/import");
  await page.getByLabel("…or paste its contents").fill(exportFile("2026-10-07T10:00:00.000Z"));
  await page.getByRole("button", { name: "Send for approval" }).first().click();
  await expect(page.locator(".notice-error")).toContainText("already imported");

  // The imported owner step is in My tasks, and search finds it.
  await page.goto("/m/tasks");
  await expect(page.getByText(`Share a safe sample ${run}`)).toBeVisible();
  await page.goto(`/search?q=${encodeURIComponent(`safe sample ${run}`)}`);
  await expect(page.getByTestId("search-results").getByText(`Share a safe sample ${run}`)).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";

/**
 * Docs, end to end: the seeded handbook, running a procedure as a checklist
 * (with a "No" answer that flags the run), writing and editing a page with an
 * internal link, its history and diff, and a Markdown import that is ONE
 * approval (with a diff per file) and writes each file once even when approved twice.
 * Works on a fresh database (it makes the owner) or after the smoke test (it signs in).
 */

const run = process.env.SUITE_E2E_RUN ?? Date.now().toString(36);
const owner = { name: "Olive Owner", email: "owner@example.test", password: "owner password long enough" };

async function ownerSession(page: Page) {
  await page.goto("/");
  if (new URL(page.url()).pathname === "/setup") {
    const code = process.env.SUITE_E2E_SETUP_CODE;
    if (code) await page.getByLabel("Setup code").fill(code);
    await page.getByLabel("Business name").fill(`Docs Bakery ${run}`);
    await page.getByLabel("Your name").fill(owner.name);
    await page.getByLabel("Email").fill(owner.email);
    await page.locator('input[name="password"]').fill(owner.password);
    await page.locator('input[name="confirm"]').fill(owner.password);
    await page.getByRole("button", { name: "Create the owner account" }).click();
    await expect(page.getByRole("heading", { name: "Hello, Olive" })).toBeVisible();
    return;
  }
  // An earlier spec set the suite up as the same owner: sign in.
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Olive" })).toBeVisible();
}

test("docs: run a procedure, write and edit a page, import Markdown through one approval", async ({ page }) => {
  await ownerSession(page);
  // The seed: a team space with example pages, and today's procedures on the home page.
  await expect(page.getByTestId("docs-widget").getByText("Opening checklist (example)").first()).toBeVisible();
  await page.goto("/m/docs");
  await page.getByTestId("space-list").getByRole("link", { name: /Handbook/ }).click();
  await expect(page.getByTestId("page-tree").getByText("Opening checklist (example)")).toBeVisible();

  // 1. Run the opening checklist; the fridge check is answered No.
  await page.getByTestId("page-tree").getByRole("link", { name: "Opening checklist (example)" }).click();
  await page.getByRole("button", { name: "Run this procedure" }).click();
  await expect(page).toHaveURL(/\/m\/docs\/runs\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Step 1: Done" }).click();
  await expect(page.getByTestId("step-1-done")).toContainText(`Done by ${owner.name}`);
  await page.getByRole("button", { name: "Finish the run" }).click();
  await expect(page.getByText("Steps 2, 3, 4 are not ticked yet")).toBeVisible();
  await page.getByRole("button", { name: "Step 2: No" }).click();
  await expect(page.getByTestId("step-2-done")).toContainText("No.");
  await page.getByLabel("Step 3: Float counted (amount)").fill("150.00");
  await page.getByRole("button", { name: "Step 3: Done" }).click();
  await expect(page.getByTestId("step-3-done")).toContainText("150.00");
  await page.getByRole("button", { name: "Step 4: Done" }).click();
  await expect(page.getByTestId("step-4-done")).toBeVisible();
  await page.getByRole("button", { name: "Finish the run" }).click();
  await expect(page.getByTestId("run-finished")).toContainText(`Finished by ${owner.name}`);
  await expect(page.getByText("A check was answered No").first()).toBeVisible();
  await page.goto("/m/docs/runs?status=completed");
  await expect(page.getByTestId("runs-table").getByText("Opening checklist (example)")).toBeVisible();

  // 2. A new page with an internal link, previewed and saved.
  await page.goto("/m/docs");
  await page.getByTestId("space-list").getByRole("link", { name: /Handbook/ }).click();
  await page.getByRole("link", { name: "New page" }).click();
  await page.getByLabel("Title").fill(`Allergens ${run}`);
  await page.getByLabel("Text (Markdown)").fill("Every cake gets a **label**.\n\nBefore opening, see [[Opening checklist (example)]].");
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByTestId("preview").locator('a[data-wiki="found"]')).toHaveText("Opening checklist (example)");
  await page.getByRole("button", { name: "Save the page" }).click();
  await expect(page.getByTestId("page-body").locator("strong")).toHaveText("label");
  const pageUrl = page.url();

  // 3. Edit it, then compare versions.
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await page.getByLabel("Text (Markdown)").fill("Every cake and loaf gets a **label**.\n\nBefore opening, see [[Opening checklist (example)]].");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("page-body")).toContainText("cake and loaf");
  await page.goto(`${pageUrl}/history/2`);
  await expect(page.getByTestId("diff").first().locator('[data-op="add"]')).toContainText("cake and loaf");
  await expect(page.getByTestId("diff").first().locator('[data-op="del"]')).toContainText("Every cake gets");

  // The checklist now lists the new page under "Linked from".
  await page.goto("/m/docs/search?q=thermometer");
  await page.getByTestId("docs-search-results").getByRole("link").first().click();
  await expect(page.getByTestId("backlinks").getByText(`Allergens ${run}`)).toBeVisible();

  // 4. Import two Markdown files: ONE approval, a diff per file, written once even when approved twice.
  await page.goto("/m/docs");
  await page.getByTestId("space-list").getByRole("link", { name: /Handbook/ }).click();
  await page.getByRole("link", { name: "Import Markdown" }).click();
  await page.locator('input[name="files"]').setInputFiles([
    { name: `deliveries-${run}.md`, mimeType: "text/markdown", buffer: Buffer.from(`# Deliveries ${run}\n\nFlour comes on Tuesdays.`) },
    { name: `clean-${run}.md`, mimeType: "text/markdown", buffer: Buffer.from(`---\nkind: procedure\n---\n# Deep clean ${run}\n\n1. Empty the fridges\n2. Mop the floor`) },
  ]);
  await page.getByRole("button", { name: "Send for approval" }).click();
  // The first visit compiles the approval page in dev, which can take a while.
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  const approvalUrl = page.url();
  await expect(page.getByTestId("approval-review")).toHaveCount(2);
  await expect(page.getByTestId("approval-review").first().locator('[data-op="add"]')).toContainText("Flour comes on Tuesdays.");
  const second = await page.context().newPage();
  await second.goto(approvalUrl);
  await page.getByRole("button", { name: "Approve all 2" }).click();
  await expect(page.getByTestId("approval-outcome")).toHaveText("2 records written.");
  await second.getByRole("button", { name: "Approve all 2" }).click();
  await expect(second.getByTestId("approval-outcome")).toHaveText("This was already approved earlier. 0 records written.");
  await second.close();
  await page.goto(`/m/docs/search?q=${encodeURIComponent(`"Deliveries ${run}"`)}`);
  await expect(page.getByTestId("docs-search-results").getByRole("link")).toHaveCount(1);
  await page.goto(`/search?q=${encodeURIComponent("mop the floor")}`);
  await expect(page.getByTestId("search-results").getByText(`Deep clean ${run}`)).toBeVisible();
});

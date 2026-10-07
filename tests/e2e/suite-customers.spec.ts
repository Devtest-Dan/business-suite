import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/**
 * Customers, end to end: the demo data is seeded, a contact is added with a
 * timeline entry and a follow-up (a card number is refused), a deal moves
 * through the pipeline, a CSV import is ONE approval that proposes a merge
 * for a duplicate and writes each row once even when approved twice, a
 * filter is saved, the list exports as CSV, and the pages fit a phone.
 *
 * Runs on a fresh database (it does the first-run setup), or after
 * smoke.spec.ts with the same SUITE_E2E_RUN (it signs in as that owner).
 */

const run = process.env.SUITE_E2E_RUN ?? Date.now().toString(36);
const owner = { name: "Olive Owner", email: `owner-${run}@example.test`, password: "owner password long enough" };
const jo = `Jo Rivera ${run}`;
const joEmail = `jo-${run}@example.test`;

async function start(page: Page) {
  await page.goto("/");
  if (/\/setup$/.test(page.url())) {
    const code = process.env.SUITE_E2E_SETUP_CODE;
    if (code) await page.getByLabel("Setup code").fill(code);
    await page.getByLabel("Business name").fill(`Northside Supplies ${run}`);
    await page.getByLabel("Your name").fill(owner.name);
    await page.getByLabel("Email").fill(owner.email);
    await page.locator('input[name="password"]').fill(owner.password);
    await page.locator('input[name="confirm"]').fill(owner.password);
    await page.getByRole("button", { name: "Create the owner account" }).click();
  } else {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("heading", { name: "Hello, Olive" })).toBeVisible();
}

test("customers: contact, timeline, follow-up, pipeline, import with merge (approved twice, written once), filter, export, phone", async ({ page }) => {
  await start(page);

  // 1. The seed: invented examples, clearly marked.
  await page.goto("/m/customers");
  await expect(page.getByTestId("contact-list").getByText("Ana Example")).toBeVisible();

  // 2. A new contact; the company is created from its name.
  await page.getByRole("link", { name: "New contact" }).click();
  await page.getByLabel("Name", { exact: true }).fill(jo);
  await page.getByLabel("Company").fill(`Northside Bakery ${run}`);
  await page.getByLabel("Email").fill(joEmail);
  await page.getByLabel("Tags").fill("vip, wholesale");
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByRole("heading", { name: jo })).toBeVisible();
  const contactUrl = page.url();

  // 3. The timeline: a call is logged; a card number is refused with a plain reason.
  await page.locator('select[name="kind"]').selectOption("call");
  await page.getByLabel("What happened").fill("Called about the spring order. Wants a quote.");
  await page.getByRole("button", { name: "Add to timeline" }).click();
  await expect(page.getByTestId("timeline").getByText("Called about the spring order. Wants a quote.")).toBeVisible();
  await page.getByLabel("What happened").fill("Pays with 4111 1111 1111 1111");
  await page.getByRole("button", { name: "Add to timeline" }).click();
  await expect(page.locator(".notice-error")).toContainText("looks like a payment card number");
  await expect(page.getByTestId("timeline").getByText("4111")).toHaveCount(0);

  // 4. A follow-up due today: on the contact, and on the home page ("what needs me").
  await page.getByText("Set a follow-up").click();
  await page.getByLabel("What needs doing").fill(`Send the quote ${run}`);
  await page.getByRole("button", { name: "Set follow-up" }).click();
  await expect(page.getByTestId("follow-up-list").getByText(`Send the quote ${run}`)).toBeVisible();
  await page.goto("/");
  await expect(page.getByTestId("needs-me").getByRole("link", { name: new RegExp(`^Today: Send the quote ${run}`) })).toBeVisible();
  // The "due" notification is sent once, on that first load; it shows from the next one.
  await page.reload();
  await expect(page.getByTestId("needs-me").getByRole("link", { name: new RegExp(`^Due today: Send the quote ${run}`) })).toBeVisible();
  await expect(page.getByTestId("customers-widget-follow-ups")).toContainText("due");

  // 5. A deal for Jo, moved along the pipeline from its card; the move is on the timeline.
  await page.goto(contactUrl);
  await page.getByRole("link", { name: "New deal" }).click();
  await page.getByLabel("Title").fill(`Spring order ${run}`);
  await page.getByLabel("Value").fill("1,250.50");
  await page.getByRole("button", { name: "Add deal" }).click();
  await expect(page.getByTestId("deal-stage")).toHaveText("New lead");
  await page.goto("/m/customers/deals");
  const card = page.getByTestId("deal-card").filter({ hasText: `Spring order ${run}` });
  await card.getByRole("combobox").selectOption({ label: "Quote sent" });
  await card.getByRole("button", { name: "Move" }).click();
  await expect(page.getByTestId("stage-Quote sent").getByRole("link", { name: `Spring order ${run}` })).toBeVisible();
  await page.goto(contactUrl);
  await expect(page.getByTestId("timeline").getByText("Moved from New lead to Quote sent.")).toBeVisible();

  // 6. Import: Jo again (same email, adds a phone) and someone new. ONE approval, a merge proposed.
  await page.goto("/m/customers/import");
  await page.getByLabel("Or paste the CSV text").fill(
    [`name,email,phone,company,tags`, `Joanna Rivera,${joEmail.toUpperCase()},555 0142,,trade-fair`, `Sam Lee ${run},sam-${run}@example.test,,Hilltop Builders ${run},`].join("\n"),
  );
  await page.getByRole("button", { name: "Check and send for approval" }).click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
  const approvalUrl = page.url();
  const rows = page.getByTestId("approval-items");
  await expect(rows.getByRole("row")).toHaveCount(3);
  await expect(rows.getByText(`Row 2: merge into the existing contact ${jo} (same email)`)).toBeVisible();
  await expect(rows.getByText(`Row 3: add a new contact Sam Lee ${run}`)).toBeVisible();
  await expect(page.getByText(/1 new contact, 1 merge into existing contacts \(by email 1, phone 0, name 0\)/)).toBeVisible();

  // Approve in two tabs: the second finds it done and writes nothing.
  const second = await page.context().newPage();
  await second.goto(approvalUrl);
  await page.getByRole("button", { name: "Approve all 2" }).click();
  await expect(page.getByTestId("approval-outcome")).toHaveText("2 records written.");
  await expect(page.getByTestId("item-result").filter({ hasText: `Merged into ${jo}: fills phone; adds tag trade-fair` })).toBeVisible();
  await second.getByRole("button", { name: "Approve all 2" }).click();
  await expect(second.getByTestId("approval-outcome")).toHaveText("This was already approved earlier. 0 records written.");
  await second.close();

  await page.goto(`/m/customers?q=${encodeURIComponent(run)}`);
  const list = page.getByTestId("contact-list");
  await expect(list.getByRole("link", { name: jo, exact: true })).toHaveCount(1);
  await expect(list.getByRole("link", { name: `Sam Lee ${run}`, exact: true })).toHaveCount(1);
  await page.goto(contactUrl);
  await expect(page.getByText("555 0142")).toBeVisible();

  // 7. A saved filter, then export what it shows.
  await page.goto("/m/customers?tag=vip");
  await expect(list.getByText(jo)).toBeVisible();
  await page.getByText("Save this filter").click();
  await page.getByLabel("Name", { exact: true }).fill("VIP customers");
  await page.getByRole("button", { name: "Save filter" }).click();
  await expect(page.getByTestId("saved-filters").getByRole("link", { name: "VIP customers" })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv.split("\r\n")[0]).toMatch(/^name,email,phone,company/);
  expect(csv).toContain(jo);
  expect(csv).not.toContain("Ana Example"); // not tagged vip

  // 8. Global search reaches the company; the pages fit a phone.
  await page.goto(`/search?q=${encodeURIComponent(`Northside Bakery ${run}`)}`);
  await expect(page.getByTestId("search-results").getByText(`Northside Bakery ${run}`)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [contactUrl, "/m/customers", "/m/customers/deals", "/m/customers/follow-ups"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

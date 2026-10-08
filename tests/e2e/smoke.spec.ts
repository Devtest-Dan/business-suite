import { expect, test, type Page } from "@playwright/test";

/**
 * The suite's promise, end to end: first-run setup creates the owner, the
 * owner invites a member (copyable link, no email server), the member signs
 * in, an announcement is posted and read, and a bulk import of announcements
 * is ONE approval that writes each row once even when approved twice.
 */

// Shared with the other specs in the same run (tasks.spec.ts signs in as this owner).
const run = (process.env.SUITE_E2E_RUN ??= Date.now().toString(36));
const owner = { name: "Olive Owner", email: "owner@example.test", password: "owner password long enough" };
const member = { name: "Max Member", email: `member-${run}@example.test`, password: "member password long enough" };
const CSV = [
  "title,body,pinned,key",
  `Stock count ${run},The stock count is on Thursday at 4pm.,no,stock-${run}`,
  `Parking ${run},Please use the back lot from Monday.,no,parking-${run}`,
  `Holiday hours ${run},We close at noon on Friday.,yes,holiday-${run}`,
].join("\n");

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^Hello,/ })).toBeVisible();
}

test("setup → invite → sign in → announcement → bulk approval (twice, written once)", async ({ page, browser }) => {
  // 1. First run: the setup page creates the owner.
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  const code = process.env.SUITE_E2E_SETUP_CODE;
  if (code) await page.getByLabel("Setup code").fill(code);
  await page.getByLabel("Business name").fill(`Acme Bakery ${run}`);
  await page.getByLabel("Your name").fill(owner.name);
  await page.getByLabel("Email").fill(owner.email);
  await page.locator('input[name="password"]').fill(owner.password);
  await page.locator('input[name="confirm"]').fill(owner.password);
  await page.getByRole("button", { name: "Create the owner account" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Olive" })).toBeVisible();
  // The module's seed ran: the welcome announcement is on the dashboard.
  await expect(page.getByText(`Welcome to Acme Bakery ${run}'s suite`).first()).toBeVisible();

  // 2. Invite a member: no SMTP, so the link is shown to copy.
  await page.goto("/people");
  await page.getByLabel("Email").fill(member.email);
  await page.getByRole("button", { name: "Make invite" }).click();
  await expect(page.getByText("copy the link")).toBeVisible();
  const inviteLink = await page.getByTestId("copy-field").inputValue();
  expect(inviteLink).toMatch(/\/invite\/[A-Za-z0-9_-]{40,}$/);

  // 3. Bulk import: three rows become ONE approval; nothing is posted yet.
  await page.goto("/m/announcements/import");
  await page.getByLabel(/CSV/).fill(CSV);
  await page.getByRole("button", { name: "Send for approval" }).click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
  const approvalUrl = page.url();
  await expect(page.getByTestId("approval-items").getByRole("row")).toHaveCount(4); // header + 3
  await page.goto("/m/announcements");
  await expect(page.getByText(`Stock count ${run}`)).toHaveCount(0);

  // 4. Approve twice: a second tab opened on the same approval before the first decision.
  const second = await page.context().newPage();
  await second.goto(approvalUrl);
  await page.goto(approvalUrl);
  await page.getByRole("button", { name: "Approve all 3" }).click();
  await expect(page.getByTestId("approval-outcome")).toHaveText("3 records written.");
  await second.getByRole("button", { name: "Approve all 3" }).click();
  await expect(second.getByTestId("approval-outcome")).toHaveText("This was already approved earlier. 0 records written.");
  await second.reload();
  await expect(second.getByTestId("count-applied")).toHaveText("3");
  await second.close();
  await page.goto("/m/announcements");
  for (const title of [`Stock count ${run}`, `Parking ${run}`, `Holiday hours ${run}`]) {
    await expect(page.getByTestId("announcement-list").getByText(title, { exact: true })).toHaveCount(1);
  }

  // 5. The owner posts an announcement by hand.
  await page.getByRole("link", { name: "New announcement" }).click();
  await page.getByLabel("Title").fill(`Team lunch ${run}`);
  await page.getByLabel("Announcement").fill("Lunch is on us this Wednesday.");
  await page.getByRole("button", { name: "Post announcement" }).click();
  await expect(page.getByTestId("announcement-body")).toHaveText("Lunch is on us this Wednesday.");
  const postUrl = page.url();

  // 6. The member accepts the invite in a separate browser, reads the post.
  const memberContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const m = await memberContext.newPage();
  await m.goto(inviteLink);
  await expect(m.getByText(member.email)).toBeVisible();
  await m.getByLabel("Your name").fill(member.name);
  await m.locator('input[name="password"]').fill(member.password);
  await m.locator('input[name="confirm"]').fill(member.password);
  await m.getByRole("button", { name: "Create my account" }).click();
  await expect(m.getByRole("heading", { name: "Hello, Max" })).toBeVisible();
  await expect(m.getByTestId("needs-me").getByText(`Read: Team lunch ${run}`)).toBeVisible();
  await m.goto(postUrl);
  await expect(m.getByTestId("announcement-body")).toBeVisible();
  // Members cannot post or import (default permissions).
  await m.goto("/m/announcements/import");
  await expect(m.getByRole("heading", { name: "You cannot open this page" })).toBeVisible();

  // 7. The member signs out and back in with the password they chose.
  await m.goto("/");
  await m.getByRole("button", { name: "Sign out" }).first().click();
  await expect(m).toHaveURL(/\/sign-in$/);
  await signIn(m, member);
  await memberContext.close();

  // 8. The owner sees the read receipt and the audit trail.
  await page.goto(postUrl);
  await expect(page.getByTestId("read-receipts").getByText(member.name)).toBeVisible();
  await page.goto("/activity");
  await expect(page.getByTestId("activity-list").getByText(/approved "Import 3 announcements"/)).toHaveCount(1);
  await expect(page.getByTestId("activity-list").getByText(`${member.name} accepted an invite and joined as member.`)).toBeVisible();

  // 9. Global search finds a bulk-imported post through Postgres full-text search.
  await page.goto(`/search?q=${encodeURIComponent("stock count thursday")}`);
  await expect(page.getByTestId("search-results").getByText(`Stock count ${run}`)).toBeVisible();
});

test("two people pressing Approve at the same moment still write each record once", async ({ page, browser }) => {
  await signIn(page, owner);
  const rows = Array.from({ length: 5 }, (_, i) => `Shift note ${i + 1} ${run},Body ${i + 1},no,shift-${i + 1}-${run}`);
  await page.goto("/m/announcements/import");
  await page.getByLabel(/CSV/).fill(["title,body,pinned,key", ...rows].join("\n"));
  await page.getByRole("button", { name: "Send for approval" }).click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
  const url = page.url();
  // A second browser, signed in separately, on the same approval.
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  const p2 = await other.newPage();
  await signIn(p2, owner);
  await p2.goto(url);
  await page.goto(url);
  await Promise.all([page.getByRole("button", { name: "Approve all 5" }).click(), p2.getByRole("button", { name: "Approve all 5" }).click()]);
  await expect(page.getByTestId("approval-outcome")).toBeVisible();
  await expect(p2.getByTestId("approval-outcome")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("count-applied")).toHaveText("5");
  await page.goto("/m/announcements");
  for (let i = 1; i <= 5; i++) {
    await expect(page.getByTestId("announcement-list").getByText(`Shift note ${i} ${run}`, { exact: true })).toHaveCount(1);
  }
  await other.close();
});

// Set SUITE_E2E_SCAFFOLD=<id> after `pnpm suite:new-module <id>` to prove the scaffold works in the browser.
test("a freshly scaffolded module works", async ({ page }) => {
  const id = process.env.SUITE_E2E_SCAFFOLD;
  test.skip(!id, "set SUITE_E2E_SCAFFOLD to a module made with pnpm suite:new-module");
  await signIn(page, owner);
  await page.goto("/apps");
  await page.getByTestId("app-launcher").getByRole("link").filter({ hasText: /./ }).last().click();
  await expect(page).toHaveURL(new RegExp(`/m/${id}$`));
  await page.getByLabel("Title").fill(`First item ${run}`);
  await page.getByLabel("Notes").fill("Made by the smoke test.");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId(`${id}-items`).getByText(`First item ${run}`)).toBeVisible();
  await page.goto(`/search?q=${encodeURIComponent("smoke test")}`);
  await expect(page.getByTestId("search-results").getByText(`First item ${run}`)).toBeVisible();
});

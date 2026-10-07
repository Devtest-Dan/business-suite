import { hash } from "@node-rs/argon2";
import { expect, test, type Browser, type Page } from "@playwright/test";
import postgres from "postgres";
import { makeZip } from "../unit/zip-fixture";

/**
 * Chat's main path in a real browser: a channel, a message that reaches
 * another person's open tab live (Server-Sent Events fed by Postgres
 * LISTEN/NOTIFY), a mention, a thread reply, a reaction, an edit, a direct
 * message, search, and a Slack import that is ONE approval in the inbox.
 *
 * Runs after the smoke test (file order) and creates its own people in the
 * e2e database; run alone, it first does the first-run setup itself.
 */

const run = process.env.SUITE_E2E_RUN ?? Date.now().toString(36);
const dbUrl = process.env.SUITE_E2E_DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite_e2e";
const owner = { name: `Cara Owner ${run}`, email: `chat-owner-${run}@example.test`, password: "chat owner password long" };
const member = { name: `Dev Member ${run}`, email: `chat-member-${run}@example.test`, password: "chat member password long" };

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto("/sign-in");
  // Already signed in (the first-run setup signs the owner in): the sign-in page sends you home.
  if (!page.url().endsWith("/sign-in")) return;
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^Hello,/ })).toBeVisible();
}

async function people(page: Page) {
  await page.goto("/");
  if (/\/setup$/.test(page.url())) {
    await page.getByLabel("Business name").fill(`Chat Test Shop ${run}`);
    await page.getByLabel("Your name").fill(owner.name);
    await page.getByLabel("Email").fill(owner.email);
    await page.locator('input[name="password"]').fill(owner.password);
    await page.locator('input[name="confirm"]').fill(owner.password);
    await page.getByRole("button", { name: "Create the owner account" }).click();
    await expect(page.getByRole("heading", { name: /^Hello,/ })).toBeVisible();
  }
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  const opts = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;
  await sql`insert into users (email, name, password_hash, role) values (${owner.email}, ${owner.name}, ${await hash(owner.password, opts)}, 'owner') on conflict (email) do nothing`;
  await sql`insert into users (email, name, password_hash, role) values (${member.email}, ${member.name}, ${await hash(member.password, opts)}, 'member') on conflict (email) do nothing`;
  await sql.end();
}

async function asMember(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, member);
  return { ctx, page };
}

test("chat: live channel, mention, thread, reaction, edit, DM, search, Slack import approval", async ({ page, browser }) => {
  await people(page);
  await signIn(page, owner);

  // A new public channel.
  const channel = `floor-${run}`.slice(0, 40);
  await page.goto("/m/chat/new");
  await page.getByLabel("Name").fill(channel);
  await page.getByLabel("Topic (optional)").fill("Shop floor");
  await page.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByTestId("conversation-title")).toHaveText(`#${channel}`);
  const channelUrl = page.url();

  // The member joins it from Browse, on a phone.
  const m = await asMember(browser);
  await m.page.goto("/m/chat/browse");
  await m.page.getByTestId("channel-directory").locator("li", { hasText: `#${channel}` }).getByRole("button", { name: "Join" }).click();
  await expect(m.page.getByTestId("composer")).toBeVisible();

  // Owner mentions the member: it appears in the member's open tab without a reload.
  await page.getByTestId("composer").fill(`Hi @${member.name}, the till roll is low`);
  await page.getByRole("button", { name: "Send" }).click();
  const live = m.page.getByTestId("message").filter({ hasText: "the till roll is low" });
  await expect(live).toBeVisible({ timeout: 30_000 });
  await expect(live.locator("span", { hasText: `@${member.name}` })).toBeVisible();

  // Member replies in a thread; the owner's view shows the reply count live.
  await live.getByTestId("message-actions").click();
  await m.page.getByRole("menuitem", { name: "Reply in thread" }).click();
  await expect(m.page.getByRole("heading", { name: "Thread" })).toBeVisible();
  await m.page.getByTestId("composer").fill("Ordered more, here Thursday");
  await m.page.getByRole("button", { name: "Send" }).click();
  await expect(m.page.getByTestId("message").filter({ hasText: "here Thursday" })).toBeVisible();
  await expect(page.getByTestId("thread-link")).toHaveText(/1 reply/, { timeout: 30_000 });

  // React and edit (own message).
  const mineId = await page.getByTestId("message").filter({ hasText: "the till roll is low" }).getAttribute("data-message-id");
  const mine = page.locator(`[data-message-id="${mineId}"]`);
  await mine.getByTestId("message-actions").click();
  await page.getByRole("menuitem", { name: "React 🎉" }).click();
  await expect(mine.getByRole("button", { name: /🎉\s*1/ })).toBeVisible();
  await mine.getByTestId("message-actions").click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByLabel("Edit message").fill(`Hi @${member.name}, the till roll is very low`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(mine.getByText("(edited)")).toBeVisible();

  // The member's notifications include the mention.
  await m.page.goto("/notifications");
  await expect(m.page.getByText(`${owner.name} mentioned you in #${channel}`)).toBeVisible();

  // A direct message, and its unread badge in the owner's list.
  await m.page.goto("/m/chat/dm");
  await m.page.getByTestId("dm-people").getByText(owner.name, { exact: true }).click();
  await m.page.getByRole("button", { name: "Open conversation" }).click();
  await m.page.getByTestId("composer").fill(`Private question ${run}`);
  await m.page.getByRole("button", { name: "Send" }).click();
  await expect(m.page.getByTestId("message").filter({ hasText: `Private question ${run}` })).toBeVisible();
  await page.goto("/m/chat");
  await expect(page.getByTestId(`chat-nav-${member.name}`).locator(".badge")).toHaveText("1");

  // Search finds the edited text; the old wording is gone.
  await page.goto(`/m/chat/search?q=${encodeURIComponent(`till roll very ${run}`)}`);
  await expect(page.getByTestId("chat-search-results").getByRole("link")).toHaveCount(1);

  // Slack import: one approval for every message; approving twice writes once.
  const slackChannel = `slack-${run}`.slice(0, 30);
  const zip = makeZip({
    "users.json": JSON.stringify([{ id: "U1", profile: { email: member.email, real_name: "Dev on Slack" } }]),
    "channels.json": JSON.stringify([{ id: `C${run}`.toUpperCase().slice(0, 20), name: slackChannel, members: ["U1"] }]),
    [`${slackChannel}/2026-09-01.json`]: JSON.stringify([
      { type: "message", user: "U1", text: `First from Slack ${run}`, ts: "1788249600.000100" },
      { type: "message", user: "U1", text: `Second from Slack ${run}`, ts: "1788249700.000100" },
    ]),
  });
  await page.goto("/m/chat/import");
  await page.locator('input[type="file"][name="file"]').setInputFiles({ name: "slack.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await page.getByRole("button", { name: "Read the export and send for approval" }).click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
  const approvalUrl = page.url();
  const second = await page.context().newPage();
  await second.goto(approvalUrl);
  await page.getByRole("button", { name: "Approve all 2" }).click();
  await expect(page.getByTestId("approval-outcome")).toHaveText("2 records written.");
  await second.getByRole("button", { name: "Approve all 2" }).click();
  await expect(second.getByTestId("approval-outcome")).toHaveText("This was already approved earlier. 0 records written.");
  await second.close();
  await page.goto(`/m/chat/search?q=${encodeURIComponent(`from Slack ${run}`)}`);
  await expect(page.getByTestId("chat-search-results").getByRole("link")).toHaveCount(2);

  // Archive: read-only for everyone.
  await page.goto(`${channelUrl}/details`);
  await page.getByRole("button", { name: "Archive channel" }).click();
  await expect(page.getByRole("button", { name: "Unarchive channel" })).toBeVisible();
  await page.goto(channelUrl);
  await expect(page.getByTestId("archived-notice")).toBeVisible();
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await m.ctx.close();
});

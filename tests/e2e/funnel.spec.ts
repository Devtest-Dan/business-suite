import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { mailText, startSmtpCatcher } from "../unit/smtp-catcher";

/**
 * Leads, end to end in Chromium: the owner sets up email (a local SMTP
 * catcher), the postal address and a lead form; an anonymous visitor fills
 * the form inside an iframe on "the owner's website" (another origin, with
 * utm_ values in its address); the lead and its notification appear; a
 * sequence is sent for approval, approved, and its first email arrives over
 * SMTP with the footer and an unsubscribe link, which the visitor uses; the
 * first contact is logged; the lead is converted and the contact and deal
 * are in Customers; the funnel report shows it and exports CSV.
 *
 * Runs on a fresh database (it does the first-run setup), or after the
 * other specs with the same SUITE_E2E_RUN. Set SUITE_E2E_EVIDENCE to a folder
 * to keep screenshots, the email and the CSV there.
 */

const run = process.env.SUITE_E2E_RUN ?? Date.now().toString(36);
const owner = { name: "Olive Owner", email: "owner@example.test", password: "owner password long enough" };
const visitorName = `Ana Reyes ${run}`;
const visitorEmail = `ana-${run}@example.test`;
const evidence = process.env.SUITE_E2E_EVIDENCE ?? "";
if (evidence) mkdirSync(evidence, { recursive: true });

async function shot(page: Page, name: string) {
  if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
}
function keep(name: string, text: string) {
  if (evidence) writeFileSync(join(evidence, name), text);
}

/** The business name the public form shows: set at setup, or whatever an earlier spec set. */
let businessName = `Greenleaf Lawn Care ${run}`;

async function start(page: Page) {
  await page.goto("/");
  // A cold dev server compiles the first page slowly: wait until it shows where we are.
  await expect(page.getByRole("heading", { name: /Set up your business suite|Sign in|Hello/ })).toBeVisible({ timeout: 90_000 });
  if (/\/setup$/.test(page.url())) {
    const code = process.env.SUITE_E2E_SETUP_CODE;
    if (code) await page.getByLabel("Setup code").fill(code);
    await page.getByLabel("Business name").fill(`Greenleaf Lawn Care ${run}`);
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
  await page.goto("/settings");
  businessName = await page.getByLabel("Business name").inputValue();
}

test("leads: form on another website → lead + alert → sequence email with unsubscribe → contact → convert into Customers → report", async ({ page, browser, request }) => {
  const smtp = await startSmtpCatcher();
  let site: Server | null = null;
  try {
    await start(page);

    // 1. The owner: email through the local SMTP catcher, then the Leads settings.
    await page.goto("/settings/email");
    await page.locator('input[name="host"]').fill("127.0.0.1");
    await page.locator('input[name="port"]').fill(String(smtp.port));
    await page.locator('input[name="from"]').fill("Greenleaf <hello@greenleaf.example>");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".notice-ok")).toBeVisible();

    await page.goto("/m/funnel/sequences");
    await expect(page.getByTestId("no-address")).toContainText("postal address");
    await page.goto("/m/funnel/settings");
    await page.locator('textarea[name="postalAddress"]').fill("1200 Oak Street\nAustin, TX 78701");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".notice-ok")).toHaveText("Saved.");

    // 2. A lead form, and its snippets.
    await page.goto("/m/funnel/forms/new");
    await page.locator('input[name="name"]').fill("Website contact");
    await page.locator('input[name="heading"]').fill("Ask for a quote");
    await page.locator('input[name="field_service"]').check();
    await page.locator('textarea[name="services"]').fill("Lawn care\nHedge trimming");
    await page.getByRole("button", { name: "Create form" }).click();
    await expect(page.getByRole("heading", { name: "Put it on your website" })).toBeVisible();
    const snippet = await page.getByTestId("iframe-snippet").inputValue();
    const hosted = (await page.getByTestId("hosted-form-link").getAttribute("href"))!;
    await shot(page, "01-form-embed");
    const headers = (await request.get(hosted)).headers();
    keep("hosted-page-headers.txt", Object.entries(headers).filter(([k]) => /content-security|x-frame|cache-control|content-type/.test(k)).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n");
    expect(headers["content-security-policy"]).toContain("frame-ancestors *");

    // 3. "The owner's website": another origin that embeds the iframe snippet.
    site = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Greenleaf</title></head><body style="font-family:sans-serif;margin:24px"><h1>Greenleaf Lawn Care</h1><p>Our own website. The form below comes from the suite.</p>${snippet}</body></html>`);
    });
    await new Promise<void>((resolve) => site!.listen(0, "127.0.0.1", resolve));
    const sitePort = (site.address() as { port: number }).port;

    // 4. An anonymous visitor (no cookies) fills the form inside the iframe.
    const anon = await browser.newContext();
    const visitor = await anon.newPage();
    await visitor.goto(`http://127.0.0.1:${sitePort}/contact?utm_source=google&utm_medium=cpc&utm_campaign=spring`);
    const frame = visitor.frameLocator("iframe[id^=lead-form-]");
    await expect(frame.locator('input[name="page_url"]')).toHaveValue(/\/contact\?utm_source=google/);
    await expect(frame.getByText(businessName)).toBeVisible();
    await frame.getByLabel("Your name", { exact: true }).fill(visitorName);
    await frame.getByLabel("Email", { exact: true }).fill(visitorEmail);
    await frame.getByLabel("Service wanted").selectOption("Lawn care");
    await frame.getByLabel("How can we help?").fill("Front and back lawn, every week from May.");
    // A card number is refused with a plain reason, inside the iframe.
    await frame.getByLabel("How can we help?").fill("Front lawn. My card is 4111 1111 1111 1111.");
    await frame.locator('input[name="consent"]').check();
    await frame.getByRole("button", { name: "Send" }).click();
    await expect(frame.getByText("This looks like a payment card number")).toBeVisible();
    await frame.getByLabel("How can we help?").fill("Front and back lawn, every week from May.");
    await frame.locator('input[name="consent"]').check();
    await shot(visitor, "02-owner-site-iframe");
    await frame.getByRole("button", { name: "Send" }).click();
    await expect(frame.getByRole("heading", { name: "Thank you" })).toBeVisible();
    await shot(visitor, "03-thank-you");

    // 5. The owner sees the lead, in What needs me and as a notification.
    await page.goto("/");
    await expect(page.getByTestId("needs-me").getByRole("link", { name: new RegExp(`New lead: ${visitorName}`) }).first()).toBeVisible();
    await expect(page.getByTestId("funnel-widget")).toBeVisible();
    await shot(page, "04-home-needs-me");
    await page.goto("/notifications");
    await expect(page.getByText(`New lead: ${visitorName}`).first()).toBeVisible();
    await shot(page, "05-notification");
    await page.goto("/m/funnel");
    await page.getByTestId("lead-list").getByRole("link", { name: visitorName }).click();
    await expect(page.getByRole("heading", { name: visitorName })).toBeVisible();
    await expect(page.getByText("utm_source google, utm_medium cpc, utm_campaign spring")).toBeVisible();
    const leadUrl = page.url();

    // 6. A sequence (the starter draft), switched on, sent to the lead: ONE approval, then the email over SMTP.
    await page.goto("/m/funnel/sequences/new");
    await page.locator('input[name="name"]').fill("New enquiry follow-up");
    await page.getByRole("button", { name: "Create sequence" }).click();
    await page.getByRole("button", { name: "Switch on" }).click();
    await expect(page.locator(".notice-ok")).toContainText("is on");
    await page.goto(leadUrl);
    await page.getByRole("button", { name: "Send for approval" }).click();
    await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("approval-items").getByText(`Send the sequence “New enquiry follow-up” to ${visitorName}`)).toBeVisible();
    await expect(page.getByTestId("approval-items")).toContainText("1200 Oak Street");
    await shot(page, "06-approval");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByTestId("approval-outcome")).toHaveText("1 record written.");
    await expect.poll(() => smtp.messages.length, { timeout: 30_000 }).toBe(1);
    const mail = smtp.messages[0];
    const text = mailText(mail);
    keep("sequence-email.eml", mail.data);
    expect(mail.to.join()).toContain(visitorEmail);
    expect(text).toContain("1200 Oak Street");
    const unsubscribe = text.match(/(http:\/\/localhost:\d+\/api\/m\/funnel\/unsubscribe\/\S+)/)![1];

    // 7. The visitor unsubscribes from the link in the email.
    await visitor.goto(unsubscribe);
    await expect(visitor.getByRole("heading", { name: "Stop these emails?" })).toBeVisible();
    await visitor.getByRole("button", { name: "Unsubscribe" }).click();
    await expect(visitor.getByRole("heading", { name: "You are unsubscribed" })).toBeVisible();
    await shot(visitor, "07-unsubscribed");
    await anon.close();

    // 8. The first contact, then the conversion into Customers.
    await page.goto(leadUrl);
    await expect(page.getByTestId("lead-timeline")).toContainText("Unsubscribed from the follow-up emails");
    await page.locator('input[name="note"]').fill("Called back, booked a visit for Thursday.");
    await page.getByRole("button", { name: "Log it" }).click();
    await expect(page.locator(".notice-ok").filter({ hasText: "Speed to lead" })).toBeVisible();
    await page.getByRole("button", { name: "Convert to customer" }).click();
    // The page reloads as converted: the work forms give way to the links into Customers.
    await expect(page.getByTestId("lead-converted")).toBeVisible();
    await expect(page.getByTestId("lead-timeline")).toContainText("Converted into a customer. Customers: Added the deal");
    await page.reload();
    await expect(page.getByTestId("lead-converted")).toBeVisible();
    await shot(page, "08-lead-converted");
    await page.getByTestId("lead-converted").getByRole("link", { name: "the contact" }).click();
    await expect(page.getByRole("heading", { name: visitorName })).toBeVisible();
    await shot(page, "09-customers-contact");
    await page.goto(leadUrl);
    await page.getByTestId("lead-converted").getByRole("link", { name: "the deal" }).click();
    await expect(page.getByTestId("deal-stage")).toHaveText("New lead");
    await expect(page.getByText(/Source: Leads: Web form “Website contact”; utm_source=google/)).toBeVisible();
    await shot(page, "10-customers-deal");

    // 9. The funnel report and its CSV.
    await page.goto("/m/funnel/report");
    await expect(page.getByTestId("report-table")).toContainText("Web form “Website contact”");
    await expect(page.getByTestId("funnel-chart")).toContainText("Converted");
    await shot(page, "11-report");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export CSV" }).click()]);
    const csv = await readFile((await download.path())!, "utf8");
    keep("funnel-report.csv", csv);
    expect(csv.split("\r\n")[0]).toBe("source,leads,contacted,qualified,converted,won,disqualified,contacted_pct,qualified_pct,converted_pct,won_pct,median_speed_to_lead_min,won_value");
    expect(csv).toContain("Web form “Website contact”,1,1,1,1,0,0,100,100,100,0");

    // 10. A phone.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(leadUrl);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    await shot(page, "12-phone-lead");
  } finally {
    await smtp.close();
    if (site) await new Promise<void>((resolve) => site!.close(() => resolve()));
  }
});

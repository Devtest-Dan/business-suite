import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke test: setup → invite → sign in → announcement → approval.
 *
 * - Locally (default): starts `next dev` on PORT (3081) against a fresh
 *   database `suite_e2e` that tests/e2e/global-setup.ts creates and migrates.
 * - Against a deployed server: set SUITE_E2E_BASE_URL (e.g. the Caddy HTTPS
 *   address of a fresh install). No server is started and nothing is reset:
 *   the server must be freshly installed (the spec creates the owner).
 */
const port = Number(process.env.PORT ?? 3081);
// One run id for every spec file, so later specs can sign in as the owner the smoke test created.
process.env.SUITE_E2E_RUN ??= Date.now().toString(36);
const external = process.env.SUITE_E2E_BASE_URL;
const baseURL = external ?? `http://localhost:${port}`;
const e2eDb = process.env.SUITE_E2E_DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite_e2e";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: external ? undefined : "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: { baseURL, ignoreHTTPSErrors: Boolean(external), trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: external
    ? undefined
    : {
        command: `pnpm exec next dev -p ${port}`,
        // A static file: the database is created by globalSetup, which Playwright runs after the server starts.
        url: `${baseURL}/icon.svg`,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
          DATABASE_URL: e2eDb,
          SUITE_SECRET_KEY: "e2e-secret-key-not-for-production-0123456789",
          SUITE_URL: baseURL,
          SUITE_FILES_DIR: "./data/e2e-files",
          SUITE_SETUP_CODE: "",
          NEXT_DIST_DIR: ".next-e2e",
          // Optional: point the Assistant app at a real brain (deploy/brain/) for its spec.
          BRAIN_URL: process.env.SUITE_E2E_BRAIN_URL ?? "",
          BRAIN_ADMIN_TOKEN: process.env.SUITE_E2E_BRAIN_ADMIN_TOKEN ?? "",
        },
      },
});

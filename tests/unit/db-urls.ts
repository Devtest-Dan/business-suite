/** Set SUITE_TEST_DATABASE to run the unit tests on another database (e.g. one per developer or agent). */
export const TEST_DATABASE = /^[a-z_][a-z0-9_]*$/.test(process.env.SUITE_TEST_DATABASE ?? "") ? process.env.SUITE_TEST_DATABASE! : "suite_test";

export function adminUrl(): string {
  return process.env.SUITE_TEST_ADMIN_URL ?? "postgres://suite:suite@localhost:5481/suite";
}

export function testUrl(): string {
  const url = new URL(adminUrl());
  url.pathname = `/${TEST_DATABASE}`;
  return url.toString();
}

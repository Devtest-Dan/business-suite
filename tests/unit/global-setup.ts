import postgres from "postgres";
import { migrate } from "../../scripts/migrate.mjs";
import { TEST_DATABASE, adminUrl, testUrl } from "./db-urls";

/** A fresh database for each test run, with every migration applied by the real runner. */
export default async function setup() {
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${TEST_DATABASE} with (force)`);
    await admin.unsafe(`create database ${TEST_DATABASE}`);
  } catch (error) {
    throw new Error(
      `The tests need a Postgres 16 server at ${adminUrl().replace(/:[^:@/]+@/, ":***@")} (set SUITE_TEST_ADMIN_URL to change it). ` +
        `Start one with: docker run -d --name suite-pg-dev -e POSTGRES_USER=suite -e POSTGRES_PASSWORD=suite -p 5481:5432 postgres:16-alpine. (${(error as Error).message})`,
    );
  } finally {
    await admin.end();
  }
  await migrate(testUrl(), { log: () => {} });
}

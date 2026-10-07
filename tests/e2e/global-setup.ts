import postgres from "postgres";
import { migrate } from "../../scripts/migrate.mjs";

/** A fresh, never-set-up database for the smoke test, migrated by the real runner. */
export default async function globalSetup() {
  const url = new URL(process.env.SUITE_E2E_DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite_e2e");
  const name = url.pathname.slice(1);
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  await migrate(url.toString(), { log: () => {} });
}

import { defineConfig } from "drizzle-kit";

// This module's own migrations. Generate with: pnpm suite:db:generate docs
export default defineConfig({
  dialect: "postgresql",
  schema: "./modules/docs/schema.ts",
  out: "./modules/docs/migrations",
  tablesFilter: ["docs_*"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite" },
  strict: true,
});

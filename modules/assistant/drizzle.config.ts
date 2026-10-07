import { defineConfig } from "drizzle-kit";

// This module's own migrations. Generate with: pnpm suite:db:generate assistant
export default defineConfig({
  dialect: "postgresql",
  schema: "./modules/assistant/schema.ts",
  out: "./modules/assistant/migrations",
  tablesFilter: ["assistant_*"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite" },
  strict: true,
});

import { defineConfig } from "drizzle-kit";

// This module's own migrations. Generate with: pnpm suite:db:generate announcements
export default defineConfig({
  dialect: "postgresql",
  schema: "./modules/announcements/schema.ts",
  out: "./modules/announcements/migrations",
  // Only this module's tables: the core tables it references are not regenerated here.
  tablesFilter: ["announcements_*"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite" },
  strict: true,
});

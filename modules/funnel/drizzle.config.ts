import { defineConfig } from "drizzle-kit";

// This module's own migrations. Generate with: pnpm suite:db:generate funnel
export default defineConfig({
  dialect: "postgresql",
  schema: "./modules/funnel/schema.ts",
  out: "./modules/funnel/migrations",
  tablesFilter: ["funnel_*"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite" },
  strict: true,
});

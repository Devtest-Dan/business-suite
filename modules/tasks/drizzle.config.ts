import { defineConfig } from "drizzle-kit";

// This module's own migrations. Generate with: pnpm suite:db:generate tasks
export default defineConfig({
  dialect: "postgresql",
  schema: "./modules/tasks/schema.ts",
  out: "./modules/tasks/migrations",
  tablesFilter: ["tasks_*"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite" },
  strict: true,
});

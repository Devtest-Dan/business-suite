import { defineConfig } from "drizzle-kit";

// This module's own migrations. Generate with: pnpm suite:db:generate customers
export default defineConfig({
  dialect: "postgresql",
  schema: "./modules/customers/schema.ts",
  out: "./modules/customers/migrations",
  tablesFilter: ["customers_*"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite" },
  strict: true,
});

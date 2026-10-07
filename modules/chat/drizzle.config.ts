import { defineConfig } from "drizzle-kit";

// This module's own migrations. Generate with: pnpm suite:db:generate chat
export default defineConfig({
  dialect: "postgresql",
  schema: "./modules/chat/schema.ts",
  out: "./modules/chat/migrations",
  tablesFilter: ["chat_*"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite" },
  strict: true,
});

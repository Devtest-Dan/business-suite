import { defineConfig } from "drizzle-kit";

// The core schema. Each module has its own config in modules/<id>/drizzle.config.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite" },
  strict: true,
  verbose: true,
});

#!/usr/bin/env node
// Generates a new migration after you change a schema:
//   pnpm suite:db:generate <module id> [name]   for a module's own tables
//   pnpm suite:db:generate core [name]          for the shell's tables (lib/db/schema.ts)
// Migrations are append-only once released: never edit one that shipped; add another.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const [id, name] = process.argv.slice(2);
if (!id) {
  console.error("Say which module: pnpm suite:db:generate <module id> [migration name]  (or 'core')");
  process.exit(1);
}
const config = id === "core" ? "drizzle.config.ts" : join("modules", id, "drizzle.config.ts");
if (!existsSync(join(ROOT, config))) {
  console.error(`There is no ${config}. Check the module id (folder name under modules/).`);
  process.exit(1);
}
const args = ["drizzle-kit", "generate", "--config", config, ...(name ? ["--name", name] : [])];
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });

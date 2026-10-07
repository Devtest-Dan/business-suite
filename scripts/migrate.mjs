#!/usr/bin/env node
// Applies the core migrations (drizzle/) and then each installed module's
// migrations (modules/<id>/migrations/), in the order modules/installed.json
// lists them. Reads drizzle-kit's output format (meta/_journal.json + <tag>.sql
// split on "--> statement-breakpoint"). Plain JavaScript on purpose: it runs in
// the production image before the server starts, where there is no TypeScript.
//
// Usage: node scripts/migrate.mjs            (DATABASE_URL from the environment)
//        node scripts/migrate.mjs --status   (prints what is applied and pending)

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";

const ROOT = resolve(import.meta.dirname, "..");
const LOCK_ID = 7_314_002; // any constant; keeps two runners from overlapping

/** @returns {{ scope: string, folder: string }[]} */
export function migrationScopes(root = ROOT) {
  const scopes = [{ scope: "core", folder: join(root, "drizzle") }];
  const installed = JSON.parse(readFileSync(join(root, "modules", "installed.json"), "utf8"));
  for (const id of installed.modules) {
    const folder = join(root, "modules", id, "migrations");
    if (existsSync(join(folder, "meta", "_journal.json"))) scopes.push({ scope: id, folder });
  }
  return scopes;
}

/** @returns {{ tag: string, hash: string, statements: string[] }[]} */
export function readMigrations(folder) {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8"));
  return journal.entries
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => {
      const sqlText = readFileSync(join(folder, `${entry.tag}.sql`), "utf8");
      return {
        tag: entry.tag,
        hash: createHash("sha256").update(sqlText).digest("hex"),
        statements: sqlText
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    });
}

/**
 * @param {string} url
 * @param {{ statusOnly?: boolean, log?: (line: string) => void, root?: string }} [options]
 */
export async function migrate(url, options = {}) {
  const log = options.log ?? ((line) => console.log(line));
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let applied = 0;
  try {
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    await sql`
      create table if not exists suite_migrations (
        scope text not null,
        tag text not null,
        hash text not null,
        applied_at timestamptz not null default now(),
        primary key (scope, tag)
      )`;
    for (const { scope, folder } of migrationScopes(options.root)) {
      const done = new Map(
        (await sql`select tag, hash from suite_migrations where scope = ${scope}`).map((r) => [r.tag, r.hash]),
      );
      for (const m of readMigrations(folder)) {
        if (done.has(m.tag)) {
          if (done.get(m.tag) !== m.hash) {
            log(`warning: ${scope}/${m.tag} changed after it was applied (migrations are append-only)`);
          }
          continue;
        }
        if (options.statusOnly) {
          log(`pending ${scope}/${m.tag}`);
          continue;
        }
        await sql.begin(async (tx) => {
          for (const statement of m.statements) await tx.unsafe(statement);
          await tx`insert into suite_migrations (scope, tag, hash) values (${scope}, ${m.tag}, ${m.hash})`;
        });
        applied += 1;
        log(`applied ${scope}/${m.tag}`);
      }
    }
    if (!options.statusOnly) log(applied ? `${applied} migration(s) applied` : "database is up to date");
    return applied;
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_ID})`.catch(() => {});
    await sql.end();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Set it to the suite's Postgres connection string and run again.");
    process.exit(1);
  }
  migrate(url, { statusOnly: process.argv.includes("--status") }).catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exit(1);
  });
}

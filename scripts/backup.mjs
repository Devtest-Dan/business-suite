#!/usr/bin/env node
// Backups: a database dump plus the uploaded files, kept on the server for
// BACKUP_KEEP_DAYS (14) and, when BACKUP_S3_* is set, copied to any
// S3-compatible bucket. Runs in the "backup" container of deploy/docker-compose.yml.
//
//   node scripts/backup.mjs --daemon        every night at BACKUP_HOUR (server timezone TZ, default 3)
//   node scripts/backup.mjs --once [--tag x] one backup now (update.sh uses --tag pre-update-<version>)
//
// Each backup is a folder /backups/<UTC timestamp>[-tag]/ with db.dump
// (pg_dump custom format), files.tar.gz and manifest.json (sizes, SHA-256).
// deploy/restore.sh puts one back.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import postgres from "postgres";
import { s3Put } from "../lib/s3-sigv4.mjs";

const env = (name, fallback = "") => process.env[name]?.trim() || fallback;
const BACKUP_DIR = env("BACKUP_DIR", "/backups");
const FILES_DIR = env("SUITE_FILES_DIR", "/data/files");
const KEEP_DAYS = Number(env("BACKUP_KEEP_DAYS", "14"));
const HOUR = Number(env("BACKUP_HOUR", "3"));
const DATABASE_URL = env("DATABASE_URL");

const log = (line) => console.log(`${new Date().toISOString()} backup: ${line}`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}: ${err.trim().slice(0, 500)}`))));
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function offsiteConfig() {
  const endpoint = env("BACKUP_S3_ENDPOINT");
  if (!endpoint) return null;
  return {
    endpoint,
    region: env("BACKUP_S3_REGION", "auto"),
    bucket: env("BACKUP_S3_BUCKET"),
    accessKeyId: env("BACKUP_S3_ACCESS_KEY_ID"),
    secretAccessKey: env("BACKUP_S3_SECRET_ACCESS_KEY"),
    prefix: env("BACKUP_S3_PREFIX", "business-suite").replace(/^\/+|\/+$/g, ""),
  };
}

/** Records the outcome in the database, so Settings can show the last backup. */
async function recordStatus(status) {
  if (!DATABASE_URL) return;
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`insert into settings (key, value, updated_at) values ('backup', ${sql.json(status)}, now())
              on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch (error) {
    log(`could not record the status in the database: ${error.message}`);
  } finally {
    await sql.end();
  }
}

export async function backupOnce(tag = "") {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const name = tag ? `${stamp}-${tag.replace(/[^a-z0-9.-]/gi, "")}` : stamp;
  const dir = join(BACKUP_DIR, name);
  await mkdir(dir, { recursive: true });
  const started = Date.now();
  try {
    await run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${join(dir, "db.dump")}`, DATABASE_URL]);
    const filesArgs = existsSync(FILES_DIR) ? ["-czf", join(dir, "files.tar.gz"), "-C", FILES_DIR, "."] : ["-czf", join(dir, "files.tar.gz"), "-T", "/dev/null"];
    await run("tar", filesArgs);
    const parts = {};
    for (const file of ["db.dump", "files.tar.gz"]) {
      const path = join(dir, file);
      parts[file] = { bytes: (await stat(path)).size, sha256: await sha256(path) };
    }
    const manifest = { name, createdAt: new Date().toISOString(), version: env("SUITE_VERSION", "unknown"), parts };
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    let offsite = null;
    const s3 = offsiteConfig();
    if (s3) {
      for (const file of ["db.dump", "files.tar.gz", "manifest.json"]) {
        const path = join(dir, file);
        const size = (await stat(path)).size;
        await s3Put(s3, `${s3.prefix}/${name}/${file}`, Readable.toWeb(createReadStream(path)), { length: size, contentType: "application/octet-stream" });
      }
      offsite = `${s3.bucket}/${s3.prefix}/${name}/`;
    }
    const pruned = await prune();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(`${name} done in ${seconds}s: db ${parts["db.dump"].bytes} bytes, files ${parts["files.tar.gz"].bytes} bytes${offsite ? `, copied to ${offsite}` : ""}${pruned ? `, removed ${pruned} old` : ""}`);
    await recordStatus({ ok: true, at: manifest.createdAt, name, bytes: parts["db.dump"].bytes + parts["files.tar.gz"].bytes, offsite });
    return { dir, manifest };
  } catch (error) {
    log(`FAILED: ${error.message}`);
    await recordStatus({ ok: false, at: new Date().toISOString(), name, error: error.message.slice(0, 300) });
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Removes local backups older than KEEP_DAYS (pre-update backups follow the same rule). */
async function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  let removed = 0;
  for (const entry of await readdir(BACKUP_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const info = await stat(join(BACKUP_DIR, entry.name));
    if (info.mtimeMs < cutoff) {
      await rm(join(BACKUP_DIR, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

function msUntilNextRun(now = new Date()) {
  const next = new Date(now);
  next.setHours(HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

async function daemon() {
  log(`scheduled every day at ${String(HOUR).padStart(2, "0")}:00 (${env("TZ", "UTC")}), keeping ${KEEP_DAYS} days in ${BACKUP_DIR}${offsiteConfig() ? ", with an off-site copy" : ""}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, msUntilNextRun()));
    await backupOnce().catch(() => {});
  }
}

const args = process.argv.slice(2);
if (args.includes("--daemon")) {
  daemon();
} else if (args.includes("--once")) {
  const tagAt = args.indexOf("--tag");
  backupOnce(tagAt >= 0 ? args[tagAt + 1] ?? "" : "")
    .then(({ dir }) => console.log(dir))
    .catch(() => process.exit(1));
} else {
  console.error("Use --once [--tag name] or --daemon.");
  process.exit(2);
}

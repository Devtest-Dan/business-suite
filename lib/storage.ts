import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { s3Delete, s3Get, s3Put } from "@/lib/s3-sigv4.mjs";

/**
 * File storage. By default files sit on the server's disk (the `files`
 * volume, included in the nightly backup). Set FILES_S3_* to keep them in any
 * S3-compatible bucket instead.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

function localPath(key: string): string {
  const base = resolve(env().filesDir);
  const full = resolve(base, key);
  if (!full.startsWith(base + sep)) throw new Error("A file key tried to leave the storage folder.");
  return full;
}

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export async function saveFile(
  input: { name: string; mime: string; bytes: Uint8Array; module?: string | null; isPublic?: boolean },
  uploadedBy: string | null,
): Promise<StoredFile> {
  if (input.bytes.byteLength === 0) throw new UserError("The file is empty. Choose another file.");
  if (input.bytes.byteLength > MAX_FILE_BYTES) throw new UserError("The file is larger than 10 MB. Make it smaller and try again.");
  const now = new Date();
  const key = join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), randomUUID()).split(sep).join("/");
  const s3 = env().s3;
  if (s3) {
    await s3Put(s3, `files/${key}`, input.bytes, { contentType: input.mime });
  } else {
    const path = localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.bytes);
  }
  const [row] = await db()
    .insert(files)
    .values({
      name: input.name.slice(0, 200) || "file",
      mime: input.mime || "application/octet-stream",
      size: input.bytes.byteLength,
      storage: s3 ? "s3" : "local",
      storageKey: key,
      module: input.module ?? null,
      isPublic: input.isPublic ?? false,
      uploadedBy,
    })
    .returning();
  return { id: row.id, name: row.name, mime: row.mime, size: row.size };
}

export async function fileRecord(id: string) {
  const [row] = await db().select().from(files).where(eq(files.id, id));
  return row ?? null;
}

export async function readStoredFile(row: { storage: "local" | "s3"; storageKey: string }): Promise<Uint8Array> {
  if (row.storage === "s3") {
    const s3 = env().s3;
    if (!s3) throw new UserError("This file is in S3 storage, but FILES_S3_* is no longer set on the server.");
    const res = await s3Get(s3, `files/${row.storageKey}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await readFile(localPath(row.storageKey)));
}

export async function deleteStoredFile(id: string): Promise<void> {
  const row = await fileRecord(id);
  if (!row) return;
  if (row.storage === "s3" && env().s3) await s3Delete(env().s3!, `files/${row.storageKey}`);
  if (row.storage === "local") await rm(localPath(row.storageKey), { force: true });
  await db().delete(files).where(eq(files.id, id));
}

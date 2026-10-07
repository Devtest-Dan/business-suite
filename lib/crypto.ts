import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** A secret as stored in the settings table: AES-256-GCM, never the plain value. */
export interface Sealed {
  sealed: string;
}

function key(): Buffer {
  const raw = env().secretKey;
  if (!raw) {
    throw new Error("SUITE_SECRET_KEY is not set, so keys cannot be stored. deploy/install.sh generates one; in development add it to .env.local.");
  }
  // Accept any length of input and derive exactly 32 bytes from it.
  return createHash("sha256").update(raw).digest();
}

export function seal(plain: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { sealed: `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${body.toString("base64url")}` };
}

export function unseal(value: Sealed): string {
  const [version, iv, tag, body] = value.sealed.split(".");
  if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("A stored secret is damaged. Enter it again in Settings.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export function isSealed(value: unknown): value is Sealed {
  return typeof value === "object" && value !== null && typeof (value as Sealed).sealed === "string";
}

/** A URL-safe random token (32 bytes) for sessions, invites and resets. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

import "server-only";
import { and, count, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { authAttempts } from "@/lib/db/schema";

export interface LimitKey {
  key: string;
  /** Failures allowed inside the window before this key is refused. */
  max: number;
}

export const SIGN_IN_WINDOW_MINUTES = 15;

export const RATE_LIMITS = {
  /** Five wrong passwords for one email, thirty from one address. */
  signIn: (email: string, ip: string): LimitKey[] => [
    { key: `email:${email}`, max: 5 },
    { key: `ip:${ip}`, max: 30 },
  ],
  /** Three reset emails per address, ten per network address. */
  resetRequest: (email: string, ip: string): LimitKey[] => [
    { key: `email:${email}`, max: 3 },
    { key: `ip:${ip}`, max: 10 },
  ],
  /** Ten wrong setup codes per network address. */
  setup: (ip: string): LimitKey[] => [{ key: `ip:${ip}`, max: 10 }],
};

/** True when any key has used up its failures in the window. */
export async function isLimited(kind: string, keys: LimitKey[], windowMinutes = SIGN_IN_WINDOW_MINUTES): Promise<boolean> {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  for (const { key, max } of keys) {
    const [row] = await db()
      .select({ n: count() })
      .from(authAttempts)
      .where(and(eq(authAttempts.kind, kind), eq(authAttempts.key, key), eq(authAttempts.success, false), gt(authAttempts.at, since)));
    if ((row?.n ?? 0) >= max) return true;
  }
  return false;
}

export async function recordAttempt(kind: string, keys: LimitKey[], success: boolean): Promise<void> {
  await db()
    .insert(authAttempts)
    .values(keys.map(({ key }) => ({ kind, key, success })));
  if (success) {
    // A correct password clears that account's failures (not the network address's).
    const accountKeys = keys.map((k) => k.key).filter((k) => k.startsWith("email:"));
    if (accountKeys.length) {
      await db()
        .delete(authAttempts)
        .where(and(eq(authAttempts.kind, kind), inArray(authAttempts.key, accountKeys), eq(authAttempts.success, false)));
    }
  }
  // Keep the table small: forget attempts older than a day.
  await db().delete(authAttempts).where(lt(authAttempts.at, new Date(Date.now() - 86_400_000)));
}

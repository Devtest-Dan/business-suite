import "server-only";
import { hash, verify } from "@node-rs/argon2";

// Argon2id with OWASP's minimum memory setting (19 MiB, 2 passes): about a
// tenth of a second on a 2 vCPU server, light enough for 50 people.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Spends the same time as a real check, so a missing account is not faster to detect. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("not-a-real-password-for-timing-only");
  await verifyPassword(await dummyHash, password);
}

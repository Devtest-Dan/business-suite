import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { acceptInvite, assertCanGrant, authenticate, consumeReset, createInvite, createOwner, createReset } from "@/lib/auth/accounts";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { seal, unseal } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { resolvePermissions } from "@/lib/permissions";
import { countRows, makeUser, resetDb } from "./helpers";

const IP = "203.0.113.7";

describe("passwords (argon2id)", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("a long enough password");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "a long enough password")).toBe(true);
    expect(await verifyPassword(hash, "wrong password here")).toBe(false);
    expect(await verifyPassword("not a hash", "x")).toBe(false);
  });
});

describe("stored secrets", () => {
  it("seals and unseals with the server key; the sealed text never holds the secret", () => {
    const s = seal("sk-deepseek-secret-value");
    expect(s.sealed).not.toContain("deepseek");
    expect(unseal(s)).toBe("sk-deepseek-secret-value");
    const tampered = { sealed: s.sealed.slice(0, -2) + (s.sealed.endsWith("A") ? "BB" : "AA") };
    expect(() => unseal(tampered)).toThrow();
  });
});

describe("accounts (real Postgres)", () => {
  beforeEach(resetDb);

  it("first-run setup creates exactly one owner, even when sent twice at once", async () => {
    const input = { name: "Olive", email: "olive@example.test", password: "a long enough password", businessName: "Acme", timezone: "UTC", setupCode: "" };
    const results = await Promise.allSettled([createOwner(input, IP), createOwner({ ...input, email: "other@example.test" }, IP)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await countRows("users")).toBe(1);
    await expect(createOwner({ ...input, email: "late@example.test" }, IP)).rejects.toThrow(/already set up/);
  });

  it("signs in with the right password and refuses the wrong one with one message for both cases", async () => {
    const u = await makeUser("member");
    expect((await authenticate(u.email, "correct horse battery", IP)).id).toBe(u.id);
    await expect(authenticate(u.email, "wrong password!!", IP)).rejects.toThrow(/do not match/);
    await expect(authenticate("nobody@example.test", "wrong password!!", IP)).rejects.toThrow(/do not match/);
  });

  it("locks an email after five wrong passwords, even with the right one", async () => {
    const u = await makeUser("member");
    for (let i = 0; i < 5; i++) await expect(authenticate(u.email, `wrong ${i} password`, IP)).rejects.toThrow(/do not match/);
    await expect(authenticate(u.email, "correct horse battery", IP)).rejects.toThrow(/Too many wrong passwords/);
  });

  it("refuses a switched-off account", async () => {
    const u = await makeUser("member");
    await db().update(users).set({ status: "disabled" }).where(eq(users.id, u.id));
    await expect(authenticate(u.email, "correct horse battery", IP)).rejects.toThrow(/switched off/);
  });

  it("an invite makes one account, once", async () => {
    const owner = await makeUser("owner");
    const { token } = await createInvite(owner, "new@example.test", "member");
    const [a, b] = await Promise.allSettled([acceptInvite(token, "New Person", "a long enough password"), acceptInvite(token, "Twin", "a long enough password")]);
    expect([a, b].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [created] = await db().select().from(users).where(eq(users.email, "new@example.test"));
    expect(created.role).toBe("member");
    await expect(acceptInvite(token, "Again", "a long enough password")).rejects.toThrow(/expired or was already used/);
  });

  it("only the owner can make admins, and nobody can invite a second owner", async () => {
    const owner = await makeUser("owner");
    const admin = await makeUser("admin");
    expect(() => assertCanGrant(owner, "admin")).not.toThrow();
    expect(() => assertCanGrant(admin, "admin")).toThrow(/Only the owner/);
    expect(() => assertCanGrant(owner, "owner")).toThrow(/one owner/);
    await expect(createInvite(admin, "x@example.test", "admin")).rejects.toThrow(/Only the owner/);
  });

  it("a reset link sets the new password and works only once", async () => {
    const owner = await makeUser("owner");
    const u = await makeUser("member");
    const token = await createReset(u.id, owner);
    await consumeReset(token, "a brand new password");
    expect((await authenticate(u.email, "a brand new password", IP)).id).toBe(u.id);
    await expect(consumeReset(token, "another new password")).rejects.toThrow(/expired or was already used/);
  });

  it("a newer reset link replaces the older one", async () => {
    const u = await makeUser("member");
    const first = await createReset(u.id, null);
    await createReset(u.id, null);
    await expect(consumeReset(first, "a brand new password")).rejects.toThrow(/expired or was already used/);
  });
});

describe("permissions", () => {
  const defs = [
    { key: "a.read", label: "", description: "", defaultRoles: ["owner", "admin", "member"] as const },
    { key: "a.write", label: "", description: "", defaultRoles: ["owner", "admin"] as const },
  ].map((d) => ({ ...d, defaultRoles: [...d.defaultRoles] }));

  it("uses the defaults, applies overrides, and the owner always holds everything", () => {
    expect([...resolvePermissions("member", defs, [])]).toEqual(["a.read"]);
    expect([...resolvePermissions("member", defs, [{ role: "member", permission: "a.write", allowed: true }])].sort()).toEqual(["a.read", "a.write"]);
    expect([...resolvePermissions("admin", defs, [{ role: "admin", permission: "a.write", allowed: false }])]).toEqual(["a.read"]);
    expect([...resolvePermissions("owner", defs, [{ role: "owner", permission: "a.write", allowed: false }])].sort()).toEqual(["a.read", "a.write"]);
    expect([...resolvePermissions("guest", defs, [])]).toEqual([]);
  });
});

import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { approve, ApprovalError, canDecide, decline, propose, stableJson } from "@/lib/approvals/ledger";
import { db } from "@/lib/db/client";
import { approvalItems, approvals, notifications } from "@/lib/db/schema";
import { countRows, makeUser, resetDb } from "./helpers";

const ACTION = "announcements.post";
const records = (n: number, prefix = "Note") => Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i + 1}`, body: `Body of ${prefix.toLowerCase()} ${i + 1}` }));

describe("approvals ledger (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    await db().execute(sql`drop trigger if exists fail_some on announcements_posts`);
  });

  it("holds a batch of N records as ONE approval and writes nothing yet", async () => {
    const admin = await makeUser("admin");
    const result = await propose({ action: ACTION, items: records(5), source: "import", requestedBy: admin });
    expect(result.accepted).toBe(5);
    expect(result.duplicates).toBe(0);
    expect(await countRows("approvals")).toBe(1);
    expect(await countRows("approval_items")).toBe(5);
    expect(await countRows("announcements_posts")).toBe(0);
  });

  it("approving twice writes each record once", async () => {
    const admin = await makeUser("admin");
    const { approvalId } = await propose({ action: ACTION, items: records(7), source: "import", requestedBy: admin });
    const first = await approve(approvalId!, admin);
    expect(first.appliedNow).toBe(7);
    expect(first.status).toBe("applied");
    const second = await approve(approvalId!, admin);
    expect(second.appliedNow).toBe(0);
    expect(second.status).toBe("applied");
    expect(await countRows("announcements_posts")).toBe(7);
  });

  it("two people approving at the same moment still write each record once", async () => {
    const owner = await makeUser("owner");
    const admin = await makeUser("admin");
    const { approvalId } = await propose({ action: ACTION, items: records(30), source: "import", requestedBy: admin });
    const [a, b] = await Promise.all([approve(approvalId!, owner), approve(approvalId!, admin)]);
    expect(a.appliedNow + b.appliedNow).toBe(30);
    expect(await countRows("announcements_posts")).toBe(30);
    const [row] = await db().select().from(approvals).where(eq(approvals.id, approvalId!));
    expect(row.appliedCount).toBe(30);
  });

  it("leaves out records the ledger already holds, across batches", async () => {
    const admin = await makeUser("admin");
    const first = await propose({ action: ACTION, items: records(4), source: "import", requestedBy: admin });
    expect(first.accepted).toBe(4);
    const again = await propose({ action: ACTION, items: records(4), source: "import", requestedBy: admin });
    expect(again.approvalId).toBeNull();
    expect(again.duplicates).toBe(4);
    const mixed = await propose({ action: ACTION, items: [...records(4), ...records(2, "Extra")], source: "import", requestedBy: admin });
    expect(mixed.accepted).toBe(2);
    expect(mixed.duplicates).toBe(4);
    expect(await countRows("approvals")).toBe(2);
  });

  it("uses explicit keys when given (the same text twice is allowed with different keys)", async () => {
    const admin = await makeUser("admin");
    const same = { title: "Same", body: "Same body" };
    const r = await propose({ action: ACTION, items: [same, same], source: "ai", requestedBy: admin, keys: ["call-1:0", "call-2:0"] });
    expect(r.accepted).toBe(2);
  });

  it("reports invalid records and leaves them out", async () => {
    const admin = await makeUser("admin");
    const r = await propose({ action: ACTION, items: [{ title: "", body: "x" }, { title: "Fine", body: "Fine" }], source: "import", requestedBy: admin });
    expect(r.accepted).toBe(1);
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0].index).toBe(0);
    const [row] = await db().select().from(approvals).where(eq(approvals.id, r.approvalId!));
    expect(row.summary).toContain("left out because they were not valid");
  });

  it("reports partial failure per record, and a retry writes only the failed ones", async () => {
    const admin = await makeUser("admin");
    await db().execute(sql`
      create or replace function fail_titles() returns trigger language plpgsql as $$
      begin if new.title like 'FAIL%' then raise exception 'refused by test trigger'; end if; return new; end $$`);
    await db().execute(sql`create trigger fail_some before insert on announcements_posts for each row execute function fail_titles()`);
    const items = [{ title: "Good 1", body: "b" }, { title: "FAIL 2", body: "b" }, { title: "Good 3", body: "b" }, { title: "FAIL 4", body: "b" }];
    const { approvalId } = await propose({ action: ACTION, items, source: "import", requestedBy: admin });
    const report = await approve(approvalId!, admin);
    expect(report.status).toBe("partially_applied");
    expect(report.appliedNow).toBe(2);
    expect(report.failedNow).toBe(2);
    expect(report.failures.map((f) => f.position)).toEqual([1, 3]);
    expect(report.failures[0].error).toContain("refused by test trigger");
    expect(await countRows("announcements_posts")).toBe(2);

    // Approving again without "retry" does not touch failed records.
    expect((await approve(approvalId!, admin)).failedNow).toBe(0);

    await db().execute(sql`drop trigger fail_some on announcements_posts`);
    const retry = await approve(approvalId!, admin, { retryFailed: true });
    expect(retry.appliedNow).toBe(2);
    expect(retry.status).toBe("applied");
    expect(await countRows("announcements_posts")).toBe(4);
  });

  it("re-claims a stale claim for database writes (the server stopped mid-batch)", async () => {
    const admin = await makeUser("admin");
    const { approvalId } = await propose({ action: ACTION, items: records(2), source: "import", requestedBy: admin });
    await db()
      .update(approvalItems)
      .set({ status: "claimed", claimedAt: new Date(Date.now() - 10 * 60_000), claimToken: "00000000-0000-4000-8000-000000000000" })
      .where(eq(approvalItems.position, 0));
    const report = await approve(approvalId!, admin);
    expect(report.appliedNow).toBe(2);
    expect(await countRows("announcements_posts")).toBe(2);
  });

  it("does not take over a fresh claim (someone else is writing it now)", async () => {
    const admin = await makeUser("admin");
    const { approvalId } = await propose({ action: ACTION, items: records(2), source: "import", requestedBy: admin });
    await db()
      .update(approvalItems)
      .set({ status: "claimed", claimedAt: new Date(), claimToken: "00000000-0000-4000-8000-000000000000" })
      .where(eq(approvalItems.position, 0));
    const report = await approve(approvalId!, admin);
    expect(report.appliedNow).toBe(1);
    expect(report.status).toBe("running");
  });

  it("approves only the selected records", async () => {
    const admin = await makeUser("admin");
    const { approvalId } = await propose({ action: ACTION, items: records(4), source: "import", requestedBy: admin });
    const items = await db().select().from(approvalItems).where(eq(approvalItems.approvalId, approvalId!)).orderBy(approvalItems.position);
    const report = await approve(approvalId!, admin, { selectedItemIds: [items[0].id, items[2].id] });
    expect(report.appliedNow).toBe(2);
    expect(report.totals.skipped).toBe(2);
    expect(report.status).toBe("applied");
  });

  it("a declined approval can never be written", async () => {
    const admin = await makeUser("admin");
    const { approvalId } = await propose({ action: ACTION, items: records(3), source: "ai", requestedBy: admin });
    await decline(approvalId!, admin, "not now");
    await expect(approve(approvalId!, admin)).rejects.toBeInstanceOf(ApprovalError);
    expect(await countRows("announcements_posts")).toBe(0);
  });

  it("only people with the permission can decide", async () => {
    const admin = await makeUser("admin");
    const member = await makeUser("member");
    const guest = await makeUser("guest");
    const { approvalId } = await propose({ action: ACTION, items: records(1), source: "ai", requestedBy: member });
    const [row] = await db().select().from(approvals).where(eq(approvals.id, approvalId!));
    expect(await canDecide(admin, row)).toBe(true);
    // A member may not post announcements, so cannot approve their own assistant's draft either.
    expect(await canDecide(member, row)).toBe(false);
    expect(await canDecide(guest, row)).toBe(false);
    await expect(approve(approvalId!, member)).rejects.toThrow(/cannot decide/);
  });

  it("deciding clears the 'waiting' notices and tells the person who asked", async () => {
    const admin = await makeUser("admin");
    const member = await makeUser("member");
    const { approvalId } = await propose({ action: ACTION, items: records(2), source: "ai", requestedBy: member });
    const waiting = await db().select().from(notifications).where(eq(notifications.userId, admin.id));
    expect(waiting).toHaveLength(1);
    expect(waiting[0].readAt).toBeNull();
    await approve(approvalId!, admin);
    const [after] = await db().select().from(notifications).where(eq(notifications.id, waiting[0].id));
    expect(after.readAt).not.toBeNull();
    const told = await db().select().from(notifications).where(eq(notifications.userId, member.id));
    expect(told.map((n) => n.kind)).toEqual(["approvals.finished"]);
  });

  it("stableJson ignores key order", () => {
    expect(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });
});

#!/usr/bin/env node
// Makes a one-time password reset link from the server itself, for when
// nobody can sign in (the owner lost their password and email is not set up):
//   sudo business-suite reset-link owner@example.com
// The link works once, for 24 hours. Recorded in the activity log.

import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email) {
  console.error("Say whose password: business-suite reset-link <email>");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
const base = (process.env.SUITE_URL ?? "").replace(/\/+$/, "");
if (!url || !base) {
  console.error("DATABASE_URL and SUITE_URL must be set (run this through `business-suite reset-link`).");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const [user] = await sql`select id, name from users where email = ${email}`;
  if (!user) {
    console.error(`No account has the email ${email}. Check the spelling.`);
    process.exitCode = 1;
  } else {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await sql.begin(async (tx) => {
      await tx`update password_resets set used_at = now() where user_id = ${user.id} and used_at is null`;
      await tx`insert into password_resets (token_hash, user_id, expires_at) values (${hash}, ${user.id}, now() + interval '24 hours')`;
      await tx`insert into audit_log (actor_name, actor_kind, action, target_type, target_id, summary)
               values ('Server console', 'system', 'people.reset_link', 'user', ${user.id}, ${`A reset link for ${user.name} was made on the server.`})`;
    });
    console.log(`Reset link for ${user.name} (works once, for 24 hours):\n${base}/reset/${token}`);
  }
} finally {
  await sql.end();
}

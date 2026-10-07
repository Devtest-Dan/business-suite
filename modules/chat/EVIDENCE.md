# Evidence: Chat, run for real (2026-10-07)

Everything below ran on the developer's Windows machine against the dev
PostgreSQL 16 container (`suite-pg-dev`, database `suite_chat`), with a real
Chromium driven by Playwright. No AI key, SMTP server or push service was
used (see "Not run for real" at the end). People and the business are
invented.

## 1. The main flow in a browser, through the suite

Script: a Playwright run of two people at once: the owner on a desktop
window and a member on a phone-sized touch window (390 × 844). It was run
three times: twice against `next dev -p 3091`, once against a production
build (`next build` + `next start -p 3091`). The final run below is on dev,
after the last two fixes (listed at the end).

```
18:09:46 setup: owner created; module seeds ran
18:09:47 invite link made (no SMTP)
18:09:50 owner opened #general: http://localhost:3091/m/chat/8b5f37f5-…
18:09:55 member (phone) joined #general on first visit and opened it
18:09:56 live: member's phone tab showed the owner's message without a reload (SSE + LISTEN/NOTIFY)
18:09:58 member replied in a thread with an image (suite file storage)
18:09:58 live: owner's channel showed '1 reply' without a reload
18:10:03 owner reacted, pinned and edited (shows '(edited)')
18:10:07 member sent a DM; owner's sidebar lists it with an unread badge
18:10:08 owner got an in-app notification for the DM (kind chat.dm, push on by default)
18:10:10 search: chat search page and global search both found messages
18:10:13 Slack ZIP → one approval http://localhost:3091/approvals/fc266fef-…
18:10:14 approved: 3 records written.
18:10:16 approve button still shown after decision: false
18:10:18 imported #kitchen shows the messages, the thread and original authors
18:10:19 dark mode screenshot
```

Screenshots (in `evidence/`): `phone-live-mention.png` (the member's phone
with the mention, which arrived live), `desktop-dark-general.png` (dark
theme: pinned, edited, reaction, thread links, the DM's unread badge),
`approval-slack-import.png` (the Slack import as ONE approval with a
per-record preview), `imported-kitchen.png` (the imported channel).

## 2. One approval through the inbox

The Slack export (a real ZIP: `users.json`, `channels.json`, one day file,
three messages with one thread reply, one person with an account and one
without) became one approval. After *Approve all 3*, in the database:

```
          title          | status  | applied_count | total | decided_by
 Import 3 Slack messages | applied |             3 |     3 | Olive Owner

              body              | author_name  |  via   | reply
 Flour order goes in on Mondays | Former Baker | import | f
 Noted, thanks @Former Baker    | Max Member   | import | t
 Fridge 2 is fixed              | Max Member   | import | f
```

Approving the same batch twice from two tabs ("This was already approved
earlier. 0 records written.") is checked in `tests/e2e/team-chat.spec.ts`.

## 3. Live stream: catch-up after a reconnect, and live delivery

Against the running server, a stream opened with `Last-Event-ID: 4` (as a
reconnecting browser sends) replays one event per conversation that changed
since, then a change committed elsewhere arrives live:

```
status 200 text/event-stream; charset=utf-8
--- catch-up after Last-Event-ID 4 ---
retry: 3000
event: ready
id: 24  data: {"k":"m","c":"3e449a41-…","s":24}
id: 17  data: {"k":"m","c":"5fa96493-…","s":17}
id: 15  data: {"k":"m","c":"8b5f37f5-…","s":15}
id: 7   data: {"k":"m","c":"8f05b3f5-…","s":7}
--- live after commit ---
id: 25  data: {"k":"m","c":"3e449a41-…","s":25}
rows: channels 4, messages 9, memberships 6, reactions 1, imported 3
```

Events carry only ids; the browser fetches the content through a server
action that checks access again.

## 4. Production build and memory

`next build` compiled the module (the new `/api/m/[module]/[[...path]]`
route included). The same browser run passed against `next start`. The
server process used **about 150 MB** (Windows working set, 152,300 K) after
the run, with two browser streams having been open.

## 5. Tests

- `pnpm test`: 304 tests, 8 files, all passing (real PostgreSQL), including
  `tests/unit/chat.test.ts` (access rules for public/private/DM/guest,
  unread and mention counts, notifications by setting, threads, edits,
  deletes, reactions, the change cursor, archived channels, posting twice
  with one key, LISTEN/NOTIFY only after commit, the SSE handler with
  Last-Event-ID catch-up and a channel created after connecting, the
  assistant's post through approvals, the Slack import through approvals,
  "catch me up" against a stand-in model server with redaction) and
  `tests/unit/chat-text.test.ts` (mentions, message pieces, Slack markup,
  the ZIP reader, the import plan, cross-app input fitting, link-preview
  safety).
- `pnpm test:e2e` (`smoke.spec.ts` + `team-chat.spec.ts`, PORT=3091, own
  database `suite_chat_e2e`): 3 passed, 1 skipped (the scaffold check, which
  needs `SUITE_E2E_SCAFFOLD`).
- `pnpm typecheck`, `pnpm lint`, `pnpm suite:check`: clean.

## Fixes the real runs found

- A message posted right after someone was added to a conversation could
  be dropped from their stream while the server refreshed what they may read
  (now held until the refresh finishes; unit test added).
- A thread reply did not refresh the reply count in the channel view (the
  event names the thread; the channel view now re-reads on it too).
- A tab now catches up when its stream first opens, not only after a
  reconnect (covers the gap between drawing the page and connecting).
- Someone messaged before their first chat visit never joined `#general`
  (now tracked per person in `chat_people`).

## Not run for real

- **Web Push to a phone**: needs HTTPS and a real browser subscription. The
  notifications were written (`chat.mention`, `chat.dm` with push on by
  default); delivery uses the suite's existing Web Push path.
- **"Catch me up" with a real model**: no AI key here; it ran against a
  local stand-in server speaking the Anthropic Messages format (unit test),
  which also showed that emails and phone numbers were removed before sending.
- **Link previews of a real site**: tested with a stubbed fetch; the
  allow-list is empty by default, so previews are off.
- **Create a task / Save to docs**: not run on the chat branch (Tasks and
  Docs were not there); run after the merge, see below.
- **Behind Caddy**: not run; Caddy flushes `text/event-stream` responses by
  itself, and the response sets `X-Accel-Buffering: no` for other proxies.

## After the merge with Tasks, Docs, Customers and Assistant (2026-10-08)

Dev server on port 3096 against its own database, all six apps on, a real
brain container (`deploy/brain/`, `business-suite-brain:dev`).

- The owner took "Add and change tasks" and "Write pages" away from Members
  (Settings → Permissions), so a member's request had to wait in the inbox.
- As a member, in #general: posted "Order 25 kg flour before Friday", then
  *Create a task* and *Save to docs* on it. Both said "Sent for approval".
- As the owner in Approvals: approved "Create a task from a chat message" →
  1 record written: the task is in the Tasks project "From chat" (made on
  first use), its description ends "— Milo Member in #general", and its
  source link "From chat: #general" opens `/m/chat/<channel>?m=<message>`.
- "Save to docs" was approved while the member still could not write pages:
  the record failed with Docs' own reason ("can read the space Handbook but
  not write in it"). After giving Members "Write pages" back, *Retry 1
  failed record* wrote the page in Handbook; it shows the text and an "Open
  the message in chat" link.
- Opening that page first ran the docs server out of memory: the Markdown
  renderer looped forever on any link whose text contained `h`, `*`, `_`,
  ... (the nested call moved the shared sticky regex). Fixed in
  `modules/docs/markdown.tsx`, with a regression test in
  `tests/unit/docs-text.test.ts`.
- The assistant's MCP address (`/api/m/assistant/mcp`, `auth: "self"`):
  401 without a token; with a token made on Assistant → Coding agents,
  `initialize` answered 200 with the brain's serverInfo and `tools/list`
  200 with 7 tools. Chat's live stream (`/api/m/chat/events`,
  `auth: "session"`) answers 401 signed out and streamed in the browser.

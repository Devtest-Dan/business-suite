# Announcements

## For the owner

Announcements is where the team's news goes: something everyone should know,
posted once, with a record of who has read it. It is the smallest app in the
suite, and the one the others were modelled on.

**What is in it**

- **Posts.** A title and the text. Owners and admins post from *New
  announcement*; everyone who can see announcements gets a notification (and
  a phone push, if they allowed it). A new install starts with one pinned
  welcome post.
- **Pinning.** A pinned post stays at the top of the list until it is
  unpinned. Pin it while posting, or with the button on the post.
- **Read receipts.** A post counts as read once a person opens it. Owners and
  admins see "Read by N of M" on each post, with who has read it and when, and
  who has not read it yet.
- **The home page** shows the latest three posts and how many you have not
  read; unread posts are also in *What needs me*.
- **Search.** Posts appear in the suite's global search.
- **Import from CSV.** Paste a CSV whose first row names the columns `title`
  and `body` (optional: `pinned` with yes/no, and `key`). The whole file
  becomes **one approval**; nothing is posted until someone approves it.
  A row with a `key` is posted once even if you import the same file again,
  and approving twice never posts a row twice.
- **The assistant** can list and search announcements, and can *draft* one or
  several. A draft is held in Approvals; nobody sees it until a person
  approves it, and the activity log says it was drafted by the assistant.

Posts cannot be edited or deleted from the app yet. Write carefully, or ask
your intern to add editing (a prompt for it is below).

**Who can do what** (change it in Settings → Permissions): everyone, guests
included, can read announcements. Owners and admins can post, pin, see read
receipts and import.

## For an intern extending it (with Claude Code or Codex)

Read `docs/ADD_AN_APP.md` first; it points at this module as the example
that uses every part of the contract. Files in `modules/announcements/`:

| File | What it holds |
| --- | --- |
| `manifest.tsx` | Routes, nav, the five permissions, search, the home widget, needs-me, the notification kind, the `post` write action and the AI tools. |
| `schema.ts` | Tables `announcements_posts` (with a generated search column and a unique `source_key` that guards against duplicates from approvals) and `announcements_reads` (one row per person per post). |
| `schemas.ts` | The Zod schemas shared by the form, the AI tool and the import. |
| `data.ts` | Queries and writes: `createPost` (also records the author's own read, the activity log line, and returns `announce()` for the notification), `setPinned`, `markRead`, `receipts`, `searchPosts`. |
| `actions.ts` | Server actions, each starting with `requireModule`: post, pin, mark read, import. |
| `pages/` | The list, the post (with `mark-read.tsx`, which records the read once the post is on screen, not on a link prefetch), new, import. |

**Write action** (what the AI or an import may propose): `announcements.post`.
AI tools: read `list_announcements`, `search_announcements`; write
`post_announcement` and the batch `post_announcements` (one approval for the
whole batch).

**Prompts that work well**

- "Let admins edit an announcement: a schema for the change, a server action
  with `requireModule(MODULE_ID, P.post)`, an activity log line, and a unit test."
- "Add an 'expires on' date to announcements, hide expired ones from the list
  and the widget, and add a migration with
  `pnpm suite:db:generate announcements expires`."
- "Add an AI read tool `unread_announcements` for the person asking."

**Tests:** `tests/unit/approvals-ledger.test.ts` (the import as one approval,
written once) and `tests/e2e/smoke.spec.ts` (post, read, import and approve in a
browser). When several people share one Postgres server, give each run its own
database: `SUITE_TEST_DATABASE=suite_<you>_test pnpm test`.

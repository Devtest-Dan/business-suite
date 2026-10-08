# Chat

Team chat for up to 50 people, on the business's own server: the part of
Slack a small team uses every day, without the subscription.

## For the owner: what it does

- **Channels.** Public channels anyone on the team (not guests) can find in
  *Browse* and join; private channels only the people added can see. Each has
  a topic. `#general` is made for you and everyone joins it on their first
  visit. Archive a channel when it is finished: it stays readable and
  searchable, and nobody can post in it.
- **Direct messages.** One person, or a small group of up to nine. The same
  people always land in the same conversation.
- **Threads.** Reply under a message so the channel stays readable. The
  person who started the thread and everyone who replied hear about new
  replies.
- **Mentions.** Type `@` and a name. `@channel` (or `@everyone`, `@here`)
  alerts everyone in the channel; by default members and admins may use it
  (Settings → Permissions, "Use @channel").
- **Reactions, edits, deletes, pins.** Use a message's `⋯` menu. Edited
  messages say "(edited)". You can delete your own messages; a chat admin can
  delete anyone's, and that is recorded in the activity log.
- **Files and images.** The paperclip attaches files (10 MB each, up to ten
  per message). They are kept in the suite's own file storage: on the server's
  disk they are in the nightly backup; in an S3 bucket they are not, so turn
  on the bucket's versioning (DEPLOY.md, "Files in S3 instead of on the disk").
- **Unread and "jump to unread".** Bold names and counts in the list; a red
  count is for you (a mention or a direct message). Opening a conversation
  shows a "New messages" line and a *Jump to unread* button.
- **Notifications, per conversation.** In a conversation's *Details*: every
  message, only mentions (the default for channels), or nothing. Direct
  messages notify by default. Mentions and direct messages also go to phones
  with push switched on (Account → Push notifications).
- **Live.** New messages, edits, reactions and replies appear without
  reloading. If the connection drops (a phone going to sleep), it catches up
  by itself when it comes back.
- **Search.** Chat → Search, or the suite's global search. Only conversations
  you can read are searched.
- **Guests.** A guest sees only the channels a chat admin adds them to, and
  can message only the people in those channels. They cannot browse or create
  channels.
- **Link previews: off by default.** Chat → Chat settings lists the sites
  whose previews are allowed. For those, the server reads the page's title
  and description (text only). Other links are never fetched by the server.
- **Catch me up.** In a conversation, *Catch me up* asks the suite's AI for a
  short summary since you last read, or of the last day or week. Names and
  contact details are removed first when redaction is on (Settings → AI).
  Nothing is posted.
- **The assistant.** It can list channels, search chat and read a channel or
  thread since a time to summarise it. It can *draft* a message, which waits
  in Approvals and is posted as the person who asked once someone approves.
- **Other apps.** When the Tasks or Docs app is installed, a message's menu
  has *Create a task* (filed in the Tasks project "From chat", made on first
  use, with a link back to the message) and *Save to docs* (a new page in the
  default docs space, with the same link). If you may approve it yourself it
  happens at once; otherwise it waits in Approvals.
- **Import from Slack.** Chat → Import from Slack takes the ZIP from Slack's
  *Export data* (up to 12 MB). Channels, topics, archived state, messages and
  threads come across with their original times; people are matched to
  accounts by email, and anyone without an account keeps their Slack name.
  Direct messages, reactions and the files themselves are not imported (a
  message says which file was attached). Nothing is written until someone
  approves the batch in Approvals (up to 1,000 messages per approval);
  importing the same export again adds nothing.

Good to know:

- Files are opened by their (random, unguessable) address, which works for
  anyone signed in to the suite. Do not post a file in a private channel that
  must never be seen by someone else on the team.
- Chat is for the team's daily talk, not for regulated records: do not post
  card numbers, health records or government ids.

## For the intern: how it is built

| File | What it holds |
| --- | --- |
| `schema.ts`, `migrations/` | `chat_channels` (public, private, dm, group), `chat_members` (read marker, notification level), `chat_messages` (threads via `parent_id`, `cseq`/`seq` cursors, mentions, attachments, preview, full-text column), `chat_reactions`, `chat_people` (first visit), `chat_settings` (preview hosts). |
| `data.ts` | Who may read and post (`computeAccess`), the sidebar with unread counts, message reads, search. |
| `messages.ts` | Writing a message (mentions, thread counts, notifications by each person's setting), edit, delete, react, pin, mark read. |
| `channels.ts` | Create, join, leave, add/remove people, topic, rename, archive, direct conversations. |
| `realtime.ts`, `stream.ts` | `pg_notify` inside each write's transaction → one `LISTEN` connection per server process → Server-Sent Events at `/api/m/chat/events`. |
| `components/` | The browser side: `live.tsx` (one EventSource per tab), `conversation.tsx`, `composer.tsx` (mentions, files), `message-item.tsx`, `sidebar-list.tsx`. |
| `writes.ts` | The two approved writes: `post_message` (assistant) and `import_message` (Slack). |
| `slack-import.ts`, `zip.ts` | Reading a Slack export (a small ZIP reader, no dependency). |
| `link-preview.ts` | Allow-listed, text-only previews, refusing private addresses. |
| `cross-app.ts` | Finding the Tasks/Docs apps' actions and fitting a message into their input. |
| `summarise.ts` | Transcript for the AI tool and "Catch me up". |

How "live" works, in one paragraph: every change gives the message a new
`seq` from the `chat_seq` sequence and calls `pg_notify('chat_events', …)` in
the same transaction, so the event exists only if the change committed. The
stream sends each browser only the ids of conversations it can read; the
browser then fetches "everything in this conversation with `seq` above my
cursor" through a server action. After a reconnect, the browser's
`Last-Event-ID` gives the server its cursor and it replays one event per
conversation that changed, and the browser re-reads with a small overlap (in
case two changes committed out of order). Messages are merged by id, so
reading something twice is harmless.

Prompts that work well:

- "Read docs/apps/chat.md and modules/chat/. Add a 'saved for later' list:
  a ⋯ menu item that bookmarks a message for me, and a page listing my saved
  messages. New table `chat_saved`, migration with `pnpm suite:db:generate
  chat saved`."
- "Add a read tool `chat_unread_for_me` that lists conversations with unread
  mentions, for the assistant."
- "Add a daily digest notification for channels set to 'mentions only'."

Checks: `pnpm typecheck && pnpm lint && pnpm test && pnpm suite:check`, and
`tests/e2e/team-chat.spec.ts` for the browser path.

Not done yet (ideas for the next version): message formatting beyond links
and `code`, custom emoji, scheduled messages, typing indicators and
"who is online", importing Slack direct messages and files, and per-file
access checks tied to the channel.

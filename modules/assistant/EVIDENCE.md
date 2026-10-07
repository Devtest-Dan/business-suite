# Evidence: Assistant and business brain (2026-10-07)

Everything ran on the developer's Windows machine (Docker Desktop, VM shared
with the AHL Supabase). No production host, brain host, AI key or server was
contacted. No secrets below: the admin tokens were throwaway dev values and the
agent token was read from a scratch file and masked.

## What ran

- **GBrain for real, in a container capped at 1 GB.** `deploy/brain/Dockerfile`
  built GBrain v0.60.96.0 (commit `9dbc00c`) on Bun 1.4.2 from GitHub (image
  `business-suite-brain`, 188 MB content). `/health`:
  `{"status":"ok","version":"0.60.96.0","engine":"pglite"}`. Memory:
  370 MB after first start, 349 MB while serving the run below, 654 MB peak
  seen during the first `gbrain init` (`docker stats`; limit 1 GiB).
- **In the compose profile.** `docker compose ... --profile brain` (via
  `COMPOSE_PROFILES=brain` in the env file, as `business-suite brain on` writes
  it) started the `brain` service from `deploy/docker-compose.yml`. A container
  on the compose network then did what the app does, by service name
  (`BRAIN_URL=http://brain:7410`):

  ```
  health {"status":"ok","version":"0.60.96.0","engine":"pglite"}
  owner login 200 true
  suite client 200 true
  remember 1 inserted
  recall ["Compose check: the brain runs in the brain profile."]
  ```

  This run found a real problem first: GBrain refuses a `--public-url` that is
  neither HTTPS nor loopback (`Issuer URL must be HTTPS`, restart loop) and
  refuses a new client whose MCP URL is not under it (`invalid_grant`). Fixed:
  the brain starts with `http://127.0.0.1:7410` and the app sends that as
  `BRAIN_PUBLIC_URL` while connecting to `http://brain:7410`.
- **The suite for real**: `next dev` on port 3095, database
  `suite_assistant_dev` on `suite-pg-dev`, `BRAIN_URL` pointing at the GBrain
  container. A Chromium browser (Playwright, `tests/e2e/suite-assistant.spec.ts`
  with `SUITE_E2E_BASE_URL=http://localhost:3095`) ran the main flow: first-run
  setup (the seed wrote the four invented demo facts to the brain), add a fact,
  correct it, point Settings → AI at the stand-in model, ask a question, have the
  assistant propose a fact, **approve it in the Approvals inbox**, set a token
  limit and see the assistant pause, import an AHL export as one approval and
  approve it, import it again (nothing new), create a coding-agent token.
  Result: `1 passed (1.1m)`.
- **The model was a local stand-in** (`tests/e2e/stand-in-model.ts`): no AI key
  is available on this machine and the production DeepSeek key was not used.
  It speaks the Anthropic Messages format and follows fixed rules (call
  `recall_business_memory` / `remember_fact`, then answer with the tool
  result), so the suite's real tool loop, redaction, approvals and usage
  counting ran; no model's judgement did. A real DeepSeek or Ollama turn is the
  one-time check left for launch.

## Rows after the run (suite_assistant_dev)

```
 text                                                         |  source   |  status   | gbrain_id
 Example (invented): we open at 9:00 and close at 17:30, Mond | demo      | active    | 1
 Example (invented): refunds are given within 30 days with a  | demo      | active    | 2
 Example (invented): suppliers are paid on the 1st and the 15 | demo      | active    | 3
 Example (invented): new staff shadow a colleague for their f | demo      | active    | 4
 Deliveries realpath3 come on Tuesdays before 9:30.           | person    | corrected | 6
 the shop realpath3 closes at 16:00 on Saturdays.             | assistant | active    | 7
 Wholesale orders realpath3 need two days' notice.            | import    | active    | 8
 The owner realpath3 prefers texts to calls.                  | import    | active    | 9

 versions: 2   (the corrected fact's old wording; the imported fact's history)

 title                                        | status  | total | applied_count
 Remember a fact                              | applied |     1 |             1
 Import 2 facts into what the assistant knows | applied |     2 |             2

 month   | calls | input_tokens | output_tokens
 2026-10 |     4 |          786 |           100
```

GBrain id 5 is the superseded first wording of the corrected fact.

One assistant turn, as the page showed it (stand-in model, brain on):

```
What do we know about the back door?
Used a tool: recall_business_memory (Assistant, looked up)
recall_business_memory {"query":"back"}
Here is what I found: {"facts":[{"id":"11dd2fb9-…","text":"Agent note (realpath3b): the back door sticks in wet weather; lift it.","kind":"fact","source":"Added by a coding agent",…}],"brain":"on"}
```

## The coding-agent address (`/api/m/assistant/mcp`) against the real brain

A token made on the Coding agents page ("Claude Code on the dev laptop", 7 days):

```
no token: HTTP 401 {"error":"Send the access token as: Authorization: Bearer <token>."}
wrong token: HTTP 401 {"error":"This access token is not valid any more (revoked, expired or mistyped). Ask the owner for a new one."}
initialize: HTTP 200 {"name":"gbrain","version":"0.60.96.0"}
tools/list: HTTP 200 ["remember","entity","synthesize","whoami","recall","context_pack","delta"]
recall 'refunds': HTTP 200 [["2","Example (invented): refunds are given within 30 days with a receipt; the owner approves anything older."]]
remember a note: HTTP 200 {"id":"12",…,"status":"inserted"}
replace the owner's fact 1: HTTP 200 "Refused: an agent cannot change or replace the business's facts. Save a new note instead; only a note this same access token wrote can be replaced."
replace its own note: HTTP 200 {"id":"13",…,"status":"superseded"}
forget (not granted): HTTP 200 {"error":"unknown_operation","code":"unknown_tool","message":"Unknown: forget",…}
recall 'opening' still shows the owner's wording: ["Example (invented): we open at 9:00 and close at 17:30, Monday to Friday."]
```

The suite recorded the agent's note as `source=agent`, labelled with the
token's name, and after the replacement kept one record (`corrected`, one
earlier wording). The first pass of this check found that a replacement of the
agent's own note left the old record current; fixed (`recordAgentFacts`) and
re-run as above. An earlier browser run found that GBrain answers an exact
repeat of a fact's text with the existing id, which broke a unique index;
`gbrain_id` is no longer unique and shared brain facts are never withdrawn or
replaced through one record (unit test "keeps a brain fact two records share").

**Claude Code connected to the suite's address with the setup line shown on the page:**

```
$ claude --version
2.1.288 (Claude Code)
$ claude mcp add --scope local --transport http business-brain http://localhost:3095/api/m/assistant/mcp --header "Authorization: Bearer <token>"
Added HTTP MCP server business-brain with URL: http://localhost:3095/api/m/assistant/mcp to local config
$ claude mcp list
business-brain: http://localhost:3095/api/m/assistant/mcp (HTTP) - ✔ Connected
$ claude mcp remove --scope local business-brain
Removed MCP server business-brain from local config
```

Codex, Hermes and OpenClaw were not run against the suite (not installed
here); their lines are the ones run against the AHL brain host.

## Screens

Desktop and phone (390 px, light and dark) of What it knows, the chat and the
Coding agents page were captured; the phone pages have no sideways scroll
(`scrollWidth 390` in both themes).

## Checks

- `pnpm typecheck`, `pnpm lint`: clean. `pnpm test` (database `suite_assistant`):
  7 files, 298 tests passed, 19 of them this app's. `pnpm suite:check`: 8 passed.
- `pnpm test:e2e` once at the end on port 3095 (database `suite_assistant_e2e`,
  a fresh brain container): the assistant spec and the smoke test's main path
  passed; the smoke test's "two people pressing Approve" timed out waiting for
  the outcome on that loaded run and passed when the smoke spec was run again
  on its own (2 passed).

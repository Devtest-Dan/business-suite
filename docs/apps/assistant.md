# Assistant and business brain

The business's own AI and memory, on its own server.

## For the owner

**What it does**

- **Assistant** (menu: Assistant). Anyone with “Use the AI assistant” asks
  questions in plain words: “What do we know about refunds?”, “What are the
  latest announcements?”. It looks things up in your installed apps straight
  away and shows which tools it used. When it wants to change something
  (“Remember that we close early on Fridays”, “Post an announcement…”) it only
  *proposes* it: the change waits in **Approvals** until a person approves it.
  It never acts on its own. Whatever it reads from your apps or its memory is
  treated as data, never as instructions to follow.
- **What the assistant knows** (menu: What it knows). The facts about how your
  business works, each with where it came from (a person, the assistant after
  approval, an import, a coding agent). Search, add, **correct** (the earlier
  wording is kept as history) or **withdraw** any fact. “Remember this” buttons
  in other apps (Announcements has one) open a short form to turn what you are
  reading into one fact.
- **Assistant settings.** This month's use (model calls and tokens, per
  person), a **monthly token limit** and/or a **monthly spend limit**. For a
  spend limit, copy your AI provider's prices (per million input and output
  tokens) from its own price page: the suite never assumes a price, and the
  spend it shows is an estimate; your provider's bill is the real figure. When a
  limit is reached the assistant pauses for everyone until the 1st of next month
  (UTC) and you get one notice. Here you also choose whether personal details in
  facts are replaced with placeholders (on by default; secrets and card numbers
  are always removed).
- **Coding agents.** Give an intern's coding agent (Claude Code, Codex, Hermes,
  OpenClaw) access to the brain: a token for 7, 30 or 90 days, shown once, with
  the line to paste for each agent. The agent can recall facts and add notes. It
  cannot delete anything and cannot change or replace your facts, only notes it
  wrote itself. Revoke it any time; you see when it was last used.
- **Import a memory export.** Bring your business memory home from the AHL
  platform (below).

Which AI provider it uses is set in Settings → AI (DeepSeek by default, or a
local model through Ollama). With “Redact personal details” on there, names,
emails and phone numbers are replaced before anything leaves the server.

### The brain: on or off

Facts are always kept in the suite's own database, so the assistant works with
the brain off: it then searches facts by keyword in the database. Switching the
**brain** on adds [GBrain](https://github.com/garrytan/gbrain) (MIT), a memory
service, as one more container on your server. That is what coding agents
connect to. It is keyword-only: nothing in it is sent to an AI service to be
searched.

**Switch the brain on** (on the server):

```bash
sudo business-suite brain on       # builds and starts it (a few minutes the first time)
sudo business-suite brain status   # {"status":"ok","version":"0.60.96.0",...}
sudo business-suite brain off      # stops it; its data is kept
```

Memory: about 400 MB while it runs; its very first start briefly needs about
870 MB (it is capped at 1 GB). On a 4 GB server with the suite this fits; on a
2 GB server leave it off. Then open What it knows → “Sync with the brain” once:
facts written while it was off are sent to it.

Backups: the nightly backup covers the suite's database, which holds every fact
(text, source, history), so nothing is lost if the brain's own storage goes.
What is not in the backup is the brain's internal storage (Docker volume
`business-suite_brain_data`). If it is lost, switch the brain off and on, then
“Sync with the brain”: the facts go back in; give coding agents new tokens.

## For the intern (working with Claude Code or Codex)

Files: `modules/assistant/`.

| File | What it holds |
| --- | --- |
| `manifest.tsx` | Routes, permissions, search, widget, “what needs me”, the two write actions (`remember`, `import_fact`), the AI tools, the seed, and the `api` entry for the MCP address. |
| `facts.ts` | Facts: add (cleaned first), send to the brain, correct, withdraw, recall, adopt facts found only in the brain, agent-note records. |
| `brain.ts` | The GBrain client: memory verbs over MCP as the suite's own scoped client; minting and revoking agent tokens through GBrain's owner API. `setBrainForTests()` swaps in a fake. |
| `agents.ts` | Agent tokens and the checked MCP proxy (`/api/m/assistant/mcp`) with the replace guard. |
| `mcp.ts` | Pure MCP helpers (parse replies, find `replaces`, pair remembered texts with ids). |
| `chat.ts`, `usage.ts` | One assistant turn (the shell's tool loop with the monthly limit), usage and limits. |
| `schemas.ts` | Zod for every form, the actions and the export format. |
| `setup-lines.ts` | The per-agent setup lines shown with a new token. |

How the pieces meet:

- The chat uses the shell's tool loop (`lib/ai/assistant.ts`, `converse`), so
  every installed app's read tools and write tools are available; this module
  adds `beforeModelCall`/`afterModelCall` hooks for the monthly limit. The
  shell's `/assistant` page sends people here when this app is switched on.
- The assistant's own tools: `recall_business_memory` and `list_recent_facts`
  (read), `remember_fact` and `remember_facts` (write, held for approval).
- Other apps link to “Remember this” with
  `/m/assistant/remember?text=…&from=…&url=/m/<app>/<id>`, only when this app is
  switched on and the person holds `assistant.remember` (see
  `modules/announcements/pages/post.tsx`). Programmatic: `propose({ action:
  "assistant.remember", items: [{ text, kind, from, url }] })`.
- The coding-agent address is a module **API route** (`api` in the manifest,
  a small addition to the contract: see ADD_AN_APP.md). Every request is
  checked here (hashed token, not revoked, not expired); a `remember` that would
  replace a fact is refused unless every fact it replaces was written by the
  same token; notes the agent saves are recorded so the owner sees them.
  GBrain checks the token as well and grants agent tokens only `recall`,
  `remember`, `entity`, `context_pack`, `delta`, `synthesize` and `whoami`.
- GBrain answers an exact repeat of a fact's text with the existing fact's id,
  so `gbrain_id` is not unique: two records can share one brain fact, and
  withdrawing or correcting one never touches the shared brain fact.

Develop with a real brain:

```bash
docker build -t business-suite-brain:dev deploy/brain
docker run -d --name suite-brain --memory 1g -e GBRAIN_ADMIN_BOOTSTRAP_TOKEN=<long random> \
  -e BRAIN_PUBLIC_URL=http://127.0.0.1:7410 -p 127.0.0.1:7410:7410 -v suite-brain:/data business-suite-brain:dev
# .env.local: BRAIN_URL=http://127.0.0.1:7410 and BRAIN_ADMIN_TOKEN=<the same>
```

Without an AI key, `pnpm exec tsx tests/e2e/stand-in-model.ts 7499` runs a
stand-in model (rule-based, not a model) to drive the tool loop; point Settings
→ AI at `http://127.0.0.1:7499`.

Tests: `tests/unit/assistant-module.test.ts` (real Postgres, fake brain) and
`tests/e2e/suite-assistant.spec.ts` (set `SUITE_E2E_BRAIN_URL` and
`SUITE_E2E_BRAIN_ADMIN_TOKEN` to run it against a real brain too).

Prompts that work: “Add a read tool `facts_by_kind` to modules/assistant that
lists current facts of one kind”; “Add a Remember this button to the tasks
app's task page, shown only when the assistant app is on”.

## The memory export format (v1)

What the AHL platform's “Export my memory” button produces and Import reads
(`ahlMemoryExport` in `modules/assistant/schemas.ts`). JSON, UTF-8, at most
5 MB and 5,000 facts:

```json
{
  "format": "ahl-business-memory",
  "version": 1,
  "exportedAt": "2026-10-07T12:00:00.000Z",
  "business": { "name": "Acme Bakery" },
  "facts": [
    {
      "id": "f_0123456789abcdef0123",
      "text": "Orders over 50 loaves need a deposit.",
      "kind": "fact",
      "source": "interview",
      "sourceRef": "interview",
      "status": "corrected",
      "updatedAt": "2026-10-02T10:00:00.000Z",
      "history": [{ "text": "Big orders need a deposit.", "at": "2026-09-30T10:00:00.000Z", "by": "interview" }]
    }
  ]
}
```

- `id`: the AHL brain host's `factId` (stable; the import's dedupe key is
  `ahl:<id>`, so importing the same export twice adds nothing).
- `kind`: `fact`, `preference`, `commitment`, `event` or `belief` (anything else
  is imported as `fact`). `source`: the AHL source (`interview`, `brief`,
  `checkin`, `gateway`, `owner`, `intern`). `status`: `active`, `corrected` or
  `withdrawn`; withdrawn facts are left out. `history`: earlier wordings, newest
  first, as the brain host's `GET …/facts` returns them.
- The whole import is ONE approval with a record per fact.

# Docs: the team wiki and its procedures

## For the owner

Docs is where the business writes down how things are done, once, so nobody
has to ask twice. It replaces a rented wiki or a folder of shared documents.

- **Spaces.** A space is a shelf of pages with its own people: for example
  "Handbook", "Kitchen", "Management". A *team* space can be read by everyone
  except guests; a *private* space only by its members. In each space a person
  can be listed as a reader, an editor or a manager (managers change the space
  and who is in it). Guests only ever see the spaces you add them to. Owners
  and admins can open every space.
- **Pages.** Written in Markdown (headings, lists, tables, links, pictures) with
  a Preview button. Pages sit under other pages. Link to another page by
  writing its title in double square brackets, `[[Opening checklist]]`; each
  page shows the pages that link to it ("Linked from"). A link to a page that
  does not exist yet shows in red and opens a new page with that title.
- **History.** Every save keeps the earlier version. Open *History* on a page
  to see who changed what (added lines in green, removed in red) and to bring
  an earlier version back; that saves it as a new version, so nothing is lost.
  If two people edit the same page, the second save is stopped with a message
  saying who saved first, and their text stays in the box.
- **Templates.** Tick "Use as a template" on any page (meeting notes, a
  procedure skeleton) and it is offered when someone starts a new page.
- **Attachments.** Attach files and pictures to a page (10 MB each). They are
  kept in the suite's own file storage: in the nightly backup when that is
  the server's disk; in an S3 bucket, rely on the bucket's versioning instead
  (DEPLOY.md, "Files in S3 instead of on the disk").
- **Search.** Docs has its own search page, and pages also appear in the
  suite's global search. People only ever find pages in spaces they can open.
- **Procedures.** A page can be a *procedure*: numbered steps, each with an
  optional check, either a yes/no question ("Is the fridge at 5 °C or lower?")
  or a value to record ("Float counted"). Press **Run this procedure** to
  start a checklist for today (or another day), for yourself or for someone
  else (they are notified). Each step records who ticked it and when; a "No"
  marks the run so it stands out. *Procedure runs* keeps the record of every
  run. A procedure can be scheduled (every day, every weekday, once a week):
  it then shows on the home page and in "What needs me" on the days it is due
  until someone finishes it. Use this for opening and closing checklists,
  cleaning rotas, onboarding, month-end routines.
- **Import Markdown.** Bring pages from another wiki or a folder of `.md`
  files (Space → Import Markdown). All the files go into **one approval** in
  Approvals: nothing is written until someone approves, each file shows what
  it will add, and the same file is never imported twice. Importing a changed
  file again updates the page it made, as a new version.
- **The assistant.** It can search the docs and answer from a page (and says
  which page). It can also draft a new page or a change to a page, but it
  never saves anything itself: the draft waits in Approvals, where the change
  is shown line by line, and only a person's approval writes it. A change is
  refused if the page was edited after the assistant read it.
- **Archive.** Archiving a page (and the pages under it) or a whole space hides
  it; nothing is deleted, and it can be brought back from *Archived pages*.

Example content: a new suite starts with a "Handbook" space whose pages are
marked "(example)". They are invented to show what Docs can do: edit them into
your own or archive them.

Permissions (Settings → Permissions): open Docs (everyone, guests limited to
their spaces), write pages (members and up), make spaces (members and up),
manage every space (admins), run procedures (everyone), import Markdown
(admins).

## For an intern extending it (with Claude Code or Codex)

Read `docs/ADD_AN_APP.md` first. Everything lives in `modules/docs/`:

| File | What it holds |
| --- | --- |
| `manifest.tsx` | The module: routes, permissions, search, widget, "what needs me", the three write actions and the AI tools. |
| `access.ts` | Who may do what in a space (pure; read it before changing any permission logic). |
| `schema.ts`, `migrations/` | Tables `docs_spaces`, `docs_space_members`, `docs_pages` (with a generated `tsvector` over title, text and steps), `docs_revisions` (append-only history), `docs_links` (for backlinks), `docs_attachments`, `docs_runs`, `docs_run_steps`. |
| `data.ts` | Spaces, pages, saving with the version check (`savePage`), links, history, archive, search, attachments, import helpers. |
| `runs.ts` | Starting, ticking, finishing and listing procedure runs; what is due today. |
| `apply.ts` | The approved writes (`create_page`, `edit_page`, `import_page`). |
| `markdown.tsx` | The Markdown renderer (no dependency, builds React elements, never injects HTML). Shared by pages and the editor's preview. |
| `diff.ts`, `pages/diff-view.tsx` | The line diff used by history and approvals. |
| `text.ts` | Reading imported Markdown files; days and schedules in the business's timezone. |
| `pages/` | The screens. `editor.tsx`, `step-form.tsx`, `attach-button.tsx`, `import-picker.tsx` are the only browser components. |

Rules that keep it safe:

- Every query that lists pages goes through `readableSpaceIds()` or
  `getSpace()`/`getPage()`, which apply `accessFor()`. Do the same in anything
  new (search, widgets, AI tools), or private pages leak.
- Every write checks `canEdit(space.access)` on the server; pages only hide
  buttons for convenience.
- Saves name the version they started from (`baseRevision`); never write
  `docs_pages` without going through `savePage`/`createPage`, or history and
  links go stale.
- The approved writes check that the person who *asked* can still write in
  the space when the approval runs.

### For other apps: writing to Docs

Other modules never import Docs' code. To put something into Docs (for
example chat's "Save to docs"), propose Docs' own action when the module is
installed:

```ts
await propose({
  action: "docs.create_page",
  source: "user",
  requestedBy: ctx.viewer,
  title: "Save a message to Docs",
  items: [{ title: "Supplier contacts", body: "Markdown text…", spaceId: undefined /* the default team space */ }],
});
```

`docs.create_page` takes `{ spaceId?, parentId?, title, body, kind?, steps?, note? }`;
without `spaceId` the page goes into the oldest team space. `docs.edit_page`
takes `{ pageId, baseRevision, title?, body?, steps?, note? }` (fields left out
stay as they are). The AI tools `search_docs`, `read_doc_page`,
`list_doc_spaces` and `procedures_today` are available to the assistant.

### The approval diff (a small core addition)

A `WriteAction` may define `review(ctx, input)`, rendered under each record on
the approval page (first ten records of a batch). Docs uses it to show the
diff of a change against the version it was drafted from, and where a new or
imported page will go. See `lib/modules/contract.ts`.

### Ideas that fit

- Export a space as a folder of Markdown files (the import's format reads it back).
- Per-step photos on runs (attach a picture as the step's answer).
- A "review every N months" date on pages, shown in "What needs me".
- Notify a space's managers when a run is finished with a "No".

### Tests

`tests/unit/docs-text.test.ts` (renderer, diff, import parser, schedules,
access rules) and `tests/unit/docs.test.ts` (real PostgreSQL: access, history
and conflicts, links, archive, the three approved writes, runs).
`tests/e2e/docs.spec.ts` drives the main path in a browser.

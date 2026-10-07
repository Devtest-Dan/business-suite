#!/usr/bin/env node
// Scaffolds a working, empty module: pnpm suite:new-module <id> ["Display name"]
//
// Creates modules/<id>/ with every part of the contract filled in for a simple
// list of items (manifest, schema + first migration, page, form, search,
// widget, permissions, one read and one write AI tool), then adds the module
// to modules/installed.json and modules/registry.ts. Rename "items" to what
// the app is really about, then follow docs/ADD_AN_APP.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const id = process.argv[2];
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!id || !ID_RE.test(id)) fail('Give the module an id in kebab-case, e.g.: pnpm suite:new-module stock-list "Stock list"');
if (id.length > 30) fail("Keep the id under 30 characters: it becomes a URL segment and a table prefix.");
const dir = join(ROOT, "modules", id);
if (existsSync(dir)) fail(`modules/${id} already exists. Pick another id, or edit that module.`);

const name = process.argv[3]?.trim() || id.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const snake = id.replace(/-/g, "_");
const camel = id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const json = (v) => JSON.stringify(v);

const files = {
  "schema.ts": `/**
 * ${name}'s own tables. Every table name starts with "${snake}_".
 * Imports are relative so drizzle-kit can load this file on its own.
 * After changing it: pnpm suite:db:generate ${id}
 */
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../../lib/db/schema";
import { tsvector } from "../../lib/db/types";

export const ${camel}Items = pgTable(
  "${snake}_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when the item came from an approval (the ledger key): a second guard against duplicates.
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(sql\`setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("notes", '')), 'B')\`),
  },
  (t) => [index("${snake}_items_search_idx").using("gin", t.search)],
);
`,
  "drizzle.config.ts": `import { defineConfig } from "drizzle-kit";

// This module's own migrations. Generate with: pnpm suite:db:generate ${id}
export default defineConfig({
  dialect: "postgresql",
  schema: "./modules/${id}/schema.ts",
  out: "./modules/${id}/migrations",
  tablesFilter: ["${snake}_*"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://suite:suite@localhost:5481/suite" },
  strict: true,
});
`,
  "schemas.ts": `import { z } from "zod";

/** One item, as the form, the AI tool and imports send it. */
export const itemInput = z.object({
  title: z.string().trim().min(1, "Give the item a title.").max(200, "Keep the title under 200 characters."),
  notes: z.string().trim().max(5000, "Keep the notes under 5,000 characters.").default(""),
});
export type ItemInput = z.output<typeof itemInput>;
`,
  "data.ts": `import "server-only";
import { desc, sql } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import type { Db, DbTx } from "@/lib/db/client";
import type { ModuleContext, SearchHit } from "@/lib/modules/contract";
import { ${camel}Items } from "./schema";
import type { ItemInput } from "./schemas";

export const MODULE_ID = ${json(id)};
export const P = { access: "${id}.access", edit: "${id}.edit" } as const;

export async function listItems(ctx: ModuleContext, limit = 100) {
  return ctx.db
    .select({ id: ${camel}Items.id, title: ${camel}Items.title, notes: ${camel}Items.notes, createdAt: ${camel}Items.createdAt })
    .from(${camel}Items)
    .orderBy(desc(${camel}Items.createdAt))
    .limit(limit);
}

export async function createItem(tx: Db | DbTx, input: ItemInput, by: { id: string; name: string }, sourceKey?: string) {
  const [item] = await tx.insert(${camel}Items).values({ title: input.title, notes: input.notes, createdBy: by.id, sourceKey: sourceKey ?? null }).returning({ id: ${camel}Items.id, title: ${camel}Items.title });
  await audit({ actor: userActor(by), action: "${id}.created", module: MODULE_ID, target: { type: "item", id: item.id }, summary: \`\${by.name} added "\${item.title}" to ${name}.\` }, tx);
  return item;
}

export async function searchItems(ctx: ModuleContext, query: string, limit: number): Promise<SearchHit[]> {
  const q = sql\`websearch_to_tsquery('simple', \${query})\`;
  const rows = await ctx.db
    .select({
      id: ${camel}Items.id,
      title: ${camel}Items.title,
      createdAt: ${camel}Items.createdAt,
      rank: sql<number>\`ts_rank(\${${camel}Items.search}, \${q})\`,
      snippet: sql<string>\`ts_headline('simple', \${${camel}Items.notes}, \${q}, 'MaxWords=24, MinWords=8, StartSel=«, StopSel=»')\`,
    })
    .from(${camel}Items)
    .where(sql\`\${${camel}Items.search} @@ \${q}\`)
    .orderBy(sql\`4 desc\`)
    .limit(limit);
  return rows.map((r) => ({ title: r.title, snippet: r.snippet, url: \`/m/\${MODULE_ID}\`, rank: Number(r.rank), at: r.createdAt }));
}
`,
  "actions.ts": `"use server";

import { refresh } from "next/cache";
import { formAction } from "@/lib/forms";
import { requireModule } from "@/lib/modules/server";
import { createItem, MODULE_ID, P } from "./data";
import { itemInput } from "./schemas";

/** Every action starts with requireModule(): it checks the person and the permission. */
export const addItem = formAction(itemInput, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const item = await createItem(ctx.db, input, ctx.viewer);
  refresh();
  return { ok: \`Added “\${item.title}”.\` };
});
`,
  "pages/list.tsx": `import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import type { ModulePageProps } from "@/lib/modules/contract";
import { addItem } from "../actions";
import { listItems, P } from "../data";

export async function ListPage({ ctx }: ModulePageProps) {
  const items = await listItems(ctx);
  return (
    <div className="space-y-6">
      <header>
        <h1 className="h1">${name}</h1>
        <p className="muted">A new module. Rename “items” to what this app is about (docs/ADD_AN_APP.md).</p>
      </header>
      {ctx.can(P.edit) ? (
        <ActionForm action={addItem} submit="Add" className="card space-y-3" resetOnSuccess>
          <label className="block">
            <span className="label">Title</span>
            <input name="title" required maxLength={200} className="input" />
          </label>
          <label className="block">
            <span className="label">Notes</span>
            <textarea name="notes" rows={3} maxLength={5000} className="input" />
          </label>
        </ActionForm>
      ) : null}
      {items.length === 0 ? (
        <p className="card muted">Nothing here yet.</p>
      ) : (
        <ul className="space-y-2" data-testid="${id}-items">
          {items.map((item) => (
            <li key={item.id} className="card">
              <p className="font-medium">{item.title}</p>
              {item.notes ? <p className="muted whitespace-pre-line text-sm">{item.notes}</p> : null}
              <p className="text-xs text-subtle">{formatDateTime(item.createdAt, ctx.business.timezone)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
`,
  "manifest.tsx": `import { z } from "zod";
import { defineAction, defineModule, defineReadTool } from "@/lib/modules/contract";
import { createItem, listItems, MODULE_ID, P, searchItems } from "./data";
import { ListPage } from "./pages/list";
import { itemInput, type ItemInput } from "./schemas";

/** ${name}. Scaffolded by pnpm suite:new-module; see docs/ADD_AN_APP.md. */
export const ${camel} = defineModule({
  id: MODULE_ID,
  name: ${json(name)},
  description: ${json(`${name}: describe in one line what it is for.`)},
  version: "0.1.0",
  icon: "box",
  nav: [{ label: ${json(name)}, path: "" }],
  permissions: [
    { key: P.access, label: ${json(`See ${name}`)}, description: "Open the app and read its items.", defaultRoles: ["owner", "admin", "member"] },
    { key: P.edit, label: ${json(`Edit ${name}`)}, description: "Add items.", defaultRoles: ["owner", "admin", "member"] },
  ],
  routes: [{ path: "", title: ${json(name)}, permission: P.access, page: ListPage }],
  migrations: { folder: "modules/${id}/migrations" },
  search: { label: ${json(name)}, permission: P.access, search: searchItems },
  notifications: [],
  widget: {
    title: ${json(name)},
    permission: P.access,
    render: async (ctx) => {
      const items = await listItems(ctx, 3);
      return items.length ? (
        <ul className="space-y-1 text-sm">
          {items.map((i) => (
            <li key={i.id} className="truncate">{i.title}</li>
          ))}
        </ul>
      ) : (
        <p className="muted text-sm">Nothing yet.</p>
      );
    },
  },
  needsMe: async () => [],
  actions: [
    defineAction<ItemInput>({
      name: "create_item",
      label: "Add an item",
      permission: P.edit,
      input: itemInput,
      preview: (i) => \`Add “\${i.title}”\`,
      sideEffects: "database",
      apply: async (ctx, input) => {
        const item = await createItem(ctx.tx, input, ctx.requestedBy ?? ctx.approver, \`\${ctx.approvalId}:\${ctx.dedupeKey}\`);
        return { targetId: item.id, summary: \`Added “\${item.title}”\` };
      },
    }),
  ],
  aiTools: [
    defineReadTool<{ limit: number }>({
      name: "list_${snake}_items",
      description: ${json(`List the newest items in ${name}.`)},
      permission: P.access,
      input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      run: async (ctx, { limit }) => listItems(ctx, limit),
    }),
    { kind: "write", name: "create_${snake}_item", description: ${json(`Add one item to ${name}.`)}, action: "create_item" },
  ],
});
`,
};

mkdirSync(join(dir, "pages"), { recursive: true });
for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);

// installed.json: the migration order.
const installedPath = join(ROOT, "modules", "installed.json");
const installed = JSON.parse(readFileSync(installedPath, "utf8"));
installed.modules.push(id);
writeFileSync(installedPath, `${JSON.stringify(installed, null, 2)}\n`);

// registry.ts: the import and the list entry.
const registryPath = join(ROOT, "modules", "registry.ts");
let registry = readFileSync(registryPath, "utf8");
const imports = [...registry.matchAll(/^import .*;$/gm)];
const lastImport = imports[imports.length - 1];
const at = lastImport.index + lastImport[0].length;
registry = `${registry.slice(0, at)}\nimport { ${camel} } from "./${id}/manifest";${registry.slice(at)}`;
registry = registry.replace(/(export const modules: ModuleManifest\[\] = \[[\s\S]*?)(\];)/, (_m, list, end) => `${list.trimEnd()}\n  ${camel},\n${end}`);
writeFileSync(registryPath, registry);

// The first migration, from schema.ts.
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["drizzle-kit", "generate", "--config", `modules/${id}/drizzle.config.ts`, "--name", snake], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});

console.log(`
Module "${id}" is ready in modules/${id}/.
Next:
  1. pnpm db:migrate               apply its migration to your database
  2. pnpm dev                      open /m/${id}
  3. pnpm suite:check              check the manifest against the contract
Then rename "items" to what the app is about, following docs/ADD_AN_APP.md.`);

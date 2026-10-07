import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule, type ModuleManifest } from "@/lib/modules/contract";
import { matchRoute } from "@/lib/modules/routing";
import { validateManifests } from "@/lib/modules/validate";
import { CORE_PERMISSIONS } from "@/lib/permissions";
import { modules } from "@/modules/registry";

const ROOT = join(import.meta.dirname, "..", "..");
const core = CORE_PERMISSIONS.map((p) => p.key);

describe("installed modules follow the contract", () => {
  it("every manifest passes the checks", () => {
    expect(validateManifests(modules, core)).toEqual([]);
  });

  it("modules/installed.json and modules/registry.ts list the same modules in the same order", () => {
    const installed = JSON.parse(readFileSync(join(ROOT, "modules", "installed.json"), "utf8")).modules;
    expect(modules.map((m) => m.id)).toEqual(installed);
  });

  it("each module has its folder, its drizzle config and a migration journal", () => {
    for (const m of modules) {
      expect(existsSync(join(ROOT, "modules", m.id, "manifest.tsx")), `${m.id}/manifest.tsx`).toBe(true);
      expect(existsSync(join(ROOT, "modules", m.id, "drizzle.config.ts")), `${m.id}/drizzle.config.ts`).toBe(true);
      expect(existsSync(join(ROOT, m.migrations.folder, "meta", "_journal.json")), `${m.id} migrations`).toBe(true);
    }
  });

  it("every write tool's action takes input the AI can be told about (JSON Schema)", () => {
    for (const m of modules) {
      for (const a of m.actions ?? []) {
        const schema = z.toJSONSchema(a.input, { io: "input", unrepresentable: "any" });
        expect(schema.type, `${m.id}.${a.name}`).toBe("object");
      }
    }
  });

  it("module tables are prefixed with the module id", () => {
    for (const m of modules) {
      const sql = readFileSync(join(ROOT, m.migrations.folder, "0000_" + m.id.replace(/-/g, "_") + ".sql"), "utf8");
      for (const [, table] of sql.matchAll(/CREATE TABLE "([^"]+)"/g)) expect(table.startsWith(`${m.id.replace(/-/g, "_")}_`), table).toBe(true);
    }
  });
});

describe("the validator catches broken manifests", () => {
  const broken = defineModule({
    id: "Bad_Id",
    name: "",
    description: "",
    version: "1",
    icon: "box",
    nav: [{ label: "Nowhere", path: "missing" }],
    permissions: [{ key: "other.thing", label: "", description: "", defaultRoles: [] }],
    routes: [{ path: "new", title: "New", permission: "nobody.has", page: () => null }],
    migrations: { folder: "somewhere" },
    notifications: [{ kind: "wrong.kind", label: "", pushByDefault: false }],
    aiTools: [{ kind: "write", name: "Bad Name", description: "", action: "nothing" }],
  });

  it("reports each problem in a plain sentence", () => {
    const problems = validateManifests([broken], core).join("\n");
    for (const expected of ["kebab-case", "give it a name", "version must look like", "migrations.folder", 'must start with "Bad_Id."', "no default roles", "which no module or the shell defines", 'path ""', "which no route serves", "notification kind", "lower_snake_case", "needs a description", "does not define"]) {
      expect(problems).toContain(expected);
    }
  });

  it("refuses two modules with the same id or the same tool name", () => {
    const [a] = modules;
    const twin: ModuleManifest = { ...a };
    const problems = validateManifests([a, twin], core).join("\n");
    expect(problems).toContain("another module already uses this id");
    expect(problems).toContain("same name as another module's tool");
  });
});

describe("the validator checks module HTTP endpoints", () => {
  const base = { id: "demo", name: "Demo", description: "", version: "1.0.0", icon: "box" as const, nav: [], routes: [{ path: "", title: "Home", page: () => null }], migrations: { folder: "modules/demo/migrations" } };
  const ok = new Response();

  it("accepts a session endpoint with a permission and a self-authenticating one without", () => {
    const m = defineModule({
      ...base,
      permissions: [{ key: "demo.read", label: "Read", description: "", defaultRoles: ["owner"] }],
      api: [
        { path: "events", methods: ["GET"], auth: "session", permission: "demo.read", handler: () => ok },
        { path: "hooks/:hookId", methods: ["POST"], auth: "self", handler: () => ok },
      ],
    });
    expect(validateManifests([m], core)).toEqual([]);
  });

  it("refuses a missing auth, a session endpoint without a known permission, a self endpoint with one, and clashing methods", () => {
    const m = defineModule({
      ...base,
      permissions: [{ key: "demo.read", label: "Read", description: "", defaultRoles: ["owner"] }],
      api: [
        { path: "a", methods: ["GET"], auth: "session", permission: "nobody.has", handler: () => ok },
        { path: "b", methods: ["GET"], auth: "session", permission: "", handler: () => ok },
        { path: "c", methods: ["POST"], auth: "self", permission: "demo.read", handler: () => ok } as never,
        { path: "d", methods: ["GET"], handler: () => ok } as never,
        { path: ":x", methods: ["GET", "POST"], auth: "self", handler: () => ok },
        { path: ":y", methods: ["POST"], auth: "self", handler: () => ok },
        { path: "", methods: [], auth: "self", handler: () => ok },
      ],
    });
    const problems = validateManifests([m], core).join("\n");
    for (const expected of ['"nobody.has", which no module', 'auth "session", so it must name a permission', 'auth "self", so the shell checks no permission', 'must say auth: "session"', 'answer POST on the same shape ":y"', "lists no HTTP methods", "one or more lower-case words"]) {
      expect(problems).toContain(expected);
    }
  });
});

describe("module routing", () => {
  const page = () => null;
  const routes = [
    { path: "", title: "Home", page },
    { path: "new", title: "New", page },
    { path: ":id", title: "One", page },
    { path: ":id/edit", title: "Edit", page },
  ];

  it("matches static segments before params", () => {
    expect(matchRoute(routes, [])?.route.title).toBe("Home");
    expect(matchRoute(routes, ["new"])?.route.title).toBe("New");
    expect(matchRoute(routes, ["abc"])).toMatchObject({ route: { title: "One" }, params: { id: "abc" } });
    expect(matchRoute(routes, ["abc", "edit"])).toMatchObject({ route: { title: "Edit" }, params: { id: "abc" } });
    expect(matchRoute(routes, ["abc", "nope"])).toBeNull();
    expect(matchRoute(routes, ["a", "b", "c"])).toBeNull();
  });
});

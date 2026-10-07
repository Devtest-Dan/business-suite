import type { ApiMethod, ModuleManifest } from "@/lib/modules/contract";
import { routeSegments } from "@/lib/modules/routing";

export const MODULE_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const API_METHODS: ApiMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ROUTE_PART_RE = /^(?::[a-zA-Z][a-zA-Z0-9]*|[a-z0-9][a-z0-9-]*)$/;

/**
 * Checks the manifests against the contract's rules. Returns one plain
 * sentence per problem (empty when all is well). Run by the unit tests and
 * by `pnpm suite:check`.
 */
export function validateManifests(modules: ModuleManifest[], corePermissions: string[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const toolNames = new Set<string>();
  const allPermissions = new Set(corePermissions);
  for (const m of modules) for (const p of m.permissions) allPermissions.add(p.key);

  for (const m of modules) {
    const where = `Module "${m.id}"`;
    if (!MODULE_ID_RE.test(m.id)) problems.push(`${where}: the id must be kebab-case (lower-case letters, digits and dashes).`);
    if (ids.has(m.id)) problems.push(`${where}: another module already uses this id.`);
    ids.add(m.id);
    if (!m.name.trim()) problems.push(`${where}: give it a name.`);
    if (!/^\d+\.\d+\.\d+$/.test(m.version)) problems.push(`${where}: version must look like 1.0.0.`);
    if (m.migrations.folder !== `modules/${m.id}/migrations`) problems.push(`${where}: migrations.folder must be "modules/${m.id}/migrations".`);

    const own = new Set<string>();
    for (const p of m.permissions) {
      if (!p.key.startsWith(`${m.id}.`)) problems.push(`${where}: permission "${p.key}" must start with "${m.id}.".`);
      if (own.has(p.key)) problems.push(`${where}: permission "${p.key}" is listed twice.`);
      own.add(p.key);
      if (p.defaultRoles.length === 0) problems.push(`${where}: permission "${p.key}" has no default roles (owners always hold it; list at least "owner").`);
    }
    const checkPermission = (perm: string | undefined, what: string) => {
      if (perm && !allPermissions.has(perm)) problems.push(`${where}: ${what} uses permission "${perm}", which no module or the shell defines.`);
    };

    const routePaths = new Set<string>();
    for (const r of m.routes) {
      const parts = routeSegments(r.path);
      if (parts.some((p) => !ROUTE_PART_RE.test(p))) problems.push(`${where}: route "${r.path}" has a segment that is not a lower-case word or ":param".`);
      const shape = parts.map((p) => (p.startsWith(":") ? ":" : p)).join("/");
      if (routePaths.has(shape)) problems.push(`${where}: two routes have the same shape "${r.path}".`);
      routePaths.add(shape);
      checkPermission(r.permission, `route "${r.path}"`);
    }
    if (!m.routes.some((r) => r.path === "")) problems.push(`${where}: add a route with path "" (the module's home page).`);
    for (const n of m.nav) {
      const shape = routeSegments(n.path).join("/");
      if (!routePaths.has(shape)) problems.push(`${where}: nav entry "${n.label}" points at "${n.path}", which no route serves.`);
      checkPermission(n.permission, `nav entry "${n.label}"`);
    }
    const apiShapes = new Set<string>();
    for (const a of m.api ?? []) {
      const parts = routeSegments(a.path);
      if (parts.length === 0 || parts.some((p) => !ROUTE_PART_RE.test(p))) problems.push(`${where}: API path "${a.path}" must be one or more lower-case words or ":param" segments.`);
      const shape = parts.map((p) => (p.startsWith(":") ? ":" : p)).join("/");
      if (a.methods.length === 0) problems.push(`${where}: API path "${a.path}" lists no HTTP methods.`);
      for (const method of a.methods) {
        if (!API_METHODS.includes(method)) problems.push(`${where}: API path "${a.path}" uses "${method}", which is not one of ${API_METHODS.join(", ")}.`);
        if (apiShapes.has(`${method} ${shape}`)) problems.push(`${where}: two API endpoints answer ${method} on the same shape "${a.path}".`);
        apiShapes.add(`${method} ${shape}`);
      }
      if (a.auth === "session") {
        if (!a.permission) problems.push(`${where}: API path "${a.path}" has auth "session", so it must name a permission.`);
        checkPermission(a.permission, `API path "${a.path}"`);
      } else if (a.auth === "self") {
        if ((a as { permission?: string }).permission) problems.push(`${where}: API path "${a.path}" has auth "self", so the shell checks no permission; remove "permission" and check access in the handler.`);
      } else {
        problems.push(`${where}: API path "${(a as { path: string }).path}" must say auth: "session" (the shell signs the person in) or auth: "self" (the handler authenticates).`);
      }
    }
    checkPermission(m.search?.permission, "the search provider");
    checkPermission(m.widget?.permission, "the dashboard widget");

    for (const k of m.notifications ?? []) {
      if (!k.kind.startsWith(`${m.id}.`)) problems.push(`${where}: notification kind "${k.kind}" must start with "${m.id}.".`);
    }

    const actionNames = new Set<string>();
    for (const a of m.actions ?? []) {
      if (!TOOL_NAME_RE.test(a.name)) problems.push(`${where}: action "${a.name}" must be lower_snake_case.`);
      if (actionNames.has(a.name)) problems.push(`${where}: action "${a.name}" is listed twice.`);
      actionNames.add(a.name);
      checkPermission(a.permission, `action "${a.name}"`);
    }
    for (const t of m.aiTools ?? []) {
      if (!TOOL_NAME_RE.test(t.name)) problems.push(`${where}: AI tool "${t.name}" must be lower_snake_case.`);
      if (toolNames.has(t.name)) problems.push(`${where}: AI tool "${t.name}" has the same name as another module's tool.`);
      toolNames.add(t.name);
      if (!t.description.trim()) problems.push(`${where}: AI tool "${t.name}" needs a description (the model reads it).`);
      if (t.kind === "read") checkPermission(t.permission, `AI tool "${t.name}"`);
      if (t.kind === "write" && !actionNames.has(t.action)) {
        problems.push(`${where}: AI tool "${t.name}" proposes action "${t.action}", which the module does not define in "actions".`);
      }
    }
  }
  return problems;
}

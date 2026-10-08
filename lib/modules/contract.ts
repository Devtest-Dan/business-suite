/**
 * The module contract: everything an app inside the suite gives the shell.
 * A module lives in `modules/<id>/`, exports one `ModuleManifest` from
 * `modules/<id>/manifest.tsx`, and is listed in `modules/installed.json` and
 * `modules/registry.ts` (`pnpm suite:new-module <id>` does all three).
 *
 * The shell reads the manifest to build the launcher and navigation, route
 * pages under /m/<id>/..., merge search results, collect "what needs me"
 * items and dashboard widgets, register notification kinds and permissions,
 * offer AI tools, and apply approved writes. A module never edits shell code.
 */
import type { ReactNode } from "react";
import type { z } from "zod";
import type { Db, DbTx } from "@/lib/db/client";
import type { ApprovalSource, Role } from "@/lib/db/schema";
import type { IconName } from "@/lib/icons";

/** The signed-in person a page, tool or action runs for. */
export interface Viewer {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/** What the shell hands to every module function. */
export interface ModuleContext {
  moduleId: string;
  viewer: Viewer;
  db: Db;
  /** True when the viewer's role holds the permission (owners hold every one). */
  can: (permission: string) => boolean;
  business: { name: string; timezone: string };
}

/** A permission the module defines. Keys are `<module id>.<verb>`, e.g. "announcements.post". */
export interface PermissionDef {
  key: string;
  label: string;
  description: string;
  /** Roles that hold it until the owner changes it in Settings → Permissions. */
  defaultRoles: Role[];
}

export interface NavEntry {
  label: string;
  /** Relative to the module's base path: "" is /m/<id>, "new" is /m/<id>/new. */
  path: string;
  icon?: IconName;
  permission?: string;
}

export interface ModulePageProps {
  ctx: ModuleContext;
  /** Values of ":name" segments in the route's path. */
  params: Record<string, string>;
  searchParams: Record<string, string | string[] | undefined>;
  /** "/m/<id>", for building links. */
  basePath: string;
}

export interface ModuleRoute {
  /** "" | "new" | ":postId" | ":postId/edit" — matched segment by segment. */
  path: string;
  title: string;
  permission?: string;
  page: (props: ModulePageProps) => Promise<ReactNode> | ReactNode;
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What a handler gets back from a parsed URL: values of its ":name" segments. */
type ApiParams = Record<string, string>;

/**
 * An HTTP endpoint the module serves at /api/m/<id>/<path>, for what a page or
 * a server action cannot do. Pick who authenticates the request with `auth`:
 *
 * - `"session"`: for the signed-in people of this suite (a live Server-Sent
 *   Events stream, a file download). The shell checks sign-in, that the
 *   module is switched on and that the person holds `permission`, then hands
 *   the handler the same `ctx` pages get. Writes from forms still belong in
 *   server actions.
 *
 * - `"self"`: for machines (a webhook, an MCP address, a feed another program
 *   reads). The shell checks only that the module is switched on.
 *   **NO ONE IS SIGNED IN AND NO PERMISSION IS CHECKED. THE HANDLER MUST
 *   AUTHENTICATE EVERY REQUEST ITSELF** (e.g. a random bearer token the module
 *   issued, stored only as a SHA-256 hash, checked before anything else) and
 *   answer 401 otherwise.
 */
export type ModuleApiRoute = SessionApiRoute | SelfAuthApiRoute;

interface ApiRouteBase {
  /** Same segment syntax as `routes`, at least one segment: "events", "mcp", "hooks/:hookId". */
  path: string;
  methods: ApiMethod[];
}

export interface SessionApiRoute extends ApiRouteBase {
  auth: "session";
  /** The person needs it; checked by the shell before the handler runs. */
  permission: string;
  handler: (request: Request, props: { ctx: ModuleContext; params: ApiParams }) => Promise<Response> | Response;
}

export interface SelfAuthApiRoute extends ApiRouteBase {
  /** The handler authenticates every request itself (see ModuleApiRoute). */
  auth: "self";
  permission?: never;
  handler: (request: Request, props: { moduleId: string; params: ApiParams }) => Promise<Response> | Response;
}

export interface SearchHit {
  title: string;
  snippet: string;
  /** Absolute path inside the suite, e.g. "/m/announcements/<id>". */
  url: string;
  /** Postgres ts_rank (or any number where higher is better). */
  rank: number;
  at?: Date | null;
}

export interface SearchProvider {
  /** Shown above this module's results. */
  label: string;
  permission?: string;
  /** `query` is the raw text; use websearch_to_tsquery on it. */
  search: (ctx: ModuleContext, query: string, limit: number) => Promise<SearchHit[]>;
}

export interface NotificationKind {
  /** `<module id>.<event>`, e.g. "announcements.posted". */
  kind: string;
  label: string;
  /** Whether Web Push is on for this kind until the person changes it. */
  pushByDefault: boolean;
}

export interface NeedsMeItem {
  title: string;
  detail?: string;
  url: string;
}

export interface DashboardWidget {
  title: string;
  permission?: string;
  render: (ctx: ModuleContext) => Promise<ReactNode> | ReactNode;
}

/** What an approved write gets: a transaction and who asked and who approved. */
export interface ApplyContext {
  tx: DbTx;
  moduleId: string;
  approvalId: string;
  /** Who proposed it: the assistant ("ai"), a bulk import ("import") or a person ("user"). */
  source: ApprovalSource;
  /** The ledger key of this record; store it if the module wants its own guard too. */
  dedupeKey: string;
  /** The person who approved. */
  approver: Viewer;
  /** The person on whose behalf the AI or the import proposed it. */
  requestedBy: Viewer | null;
  /**
   * Set when another app runs this write (e.g. "tasks" posting in Chat): that
   * app's id, so the record can say where it came from. It comes from the
   * caller's own context, or from `propose({ calledBy })` when the ledger applies
   * it. Unset for the assistant's, an import's or a person's own proposals.
   */
  calledBy?: string;
  business: { name: string; timezone: string };
}

export interface ApplyResult {
  targetId?: string;
  summary?: string;
  /** Runs after the transaction commits (e.g. send notifications). */
  after?: () => Promise<void>;
}

/**
 * A write the module allows the AI, or a bulk import, to propose. It is never
 * run directly: it waits in the approvals inbox, one approval per batch, and
 * runs once per record when a person approves.
 */
export interface WriteAction<Input = unknown> {
  /** Short name; the full name is `<module id>.<name>`. */
  name: string;
  label: string;
  /** The approver needs this permission (or "approvals.decide"). */
  permission: string;
  /** Schema for ONE record. */
  input: z.ZodType<Input>;
  /** One line that tells the approver exactly what this record will do. */
  preview: (input: Input) => string;
  /** Stable key for the ledger. Default: SHA-256 of the record's JSON. */
  dedupeKey?: (input: Input) => string;
  /**
   * "database": the write happens inside `ctx.tx`, so a crash rolls it back
   * and a stale claim can be retried. "external": it calls another system,
   * so a stale claim is never retried automatically (a person checks first).
   */
  sideEffects: "database" | "external";
  apply: (ctx: ApplyContext, input: Input) => Promise<ApplyResult>;
  /**
   * Optional: more than the one-line preview, shown under the record on the
   * approval page (e.g. a diff of a page change against the current text).
   * It may read with `ctx.db` but must never write. The shell renders it for
   * the first records of a batch only.
   */
  review?: (ctx: ReviewContext, input: Input) => Promise<ReactNode> | ReactNode;
}

/** What `WriteAction.review` gets: the person looking at the approval, and read access to the database. */
export interface ReviewContext {
  db: Db;
  viewer: Viewer;
  business: { name: string; timezone: string };
}

/** A tool that only reads. It runs at once, with the asking person's permissions. */
export interface ReadTool<Input = unknown> {
  kind: "read";
  name: string;
  description: string;
  permission: string;
  input: z.ZodType<Input>;
  run: (ctx: ModuleContext, input: Input) => Promise<unknown>;
}

/** A tool that writes. Calling it only creates an approval; nothing changes until a person approves. */
export interface WriteTool {
  kind: "write";
  name: string;
  description: string;
  /** The `WriteAction.name` it proposes. */
  action: string;
  /** true: the tool takes `{ items: Input[] }` and makes ONE approval for the whole batch. */
  batch?: boolean;
}

export type AiTool = ReadTool<never> | WriteTool;

export interface ModuleManifest {
  /** kebab-case; also the folder name, the URL segment and the table prefix. */
  id: string;
  name: string;
  description: string;
  version: string;
  icon: IconName;
  nav: NavEntry[];
  permissions: PermissionDef[];
  routes: ModuleRoute[];
  /** Optional HTTP endpoints at /api/m/<id>/<path> (see ModuleApiRoute: `auth: "self"` handlers authenticate their own requests). */
  api?: ModuleApiRoute[];
  /** The module's own Drizzle migrations, applied after the core ones. */
  migrations: { folder: string };
  search?: SearchProvider;
  notifications?: NotificationKind[];
  widget?: DashboardWidget;
  needsMe?: (ctx: ModuleContext) => Promise<NeedsMeItem[]>;
  actions?: WriteAction<never>[];
  aiTools?: AiTool[];
  /**
   * Names of the people and organisations this app keeps records of (e.g.
   * customers' contacts and companies), only those the viewer may see. With
   * redaction on, the assistant sends each as a reference instead of the name
   * and puts the name back before a tool runs, so lookups by name still work
   * (lib/ai/name-refs.ts).
   */
  knownNames?: (ctx: ModuleContext) => Promise<string[]>;
  /** Runs once, when the owner finishes setup (or the module is first switched on). */
  seed?: (ctx: ModuleContext) => Promise<void>;
}

/** Helps TypeScript check a manifest without widening it. */
export function defineModule(manifest: ModuleManifest): ModuleManifest {
  return manifest;
}

/** Keeps the per-record input type while storing actions in one list. */
export function defineAction<Input>(action: WriteAction<Input>): WriteAction<never> {
  return action as unknown as WriteAction<never>;
}

export function defineReadTool<Input>(tool: Omit<ReadTool<Input>, "kind">): ReadTool<never> {
  return { kind: "read", ...tool } as unknown as ReadTool<never>;
}

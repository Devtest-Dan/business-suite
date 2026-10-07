import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";

export type Db = PostgresJsDatabase<Record<string, never>>;
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { suiteSql?: postgres.Sql };

/** The one connection pool (kept across hot reloads in development). */
export function sqlClient(): postgres.Sql {
  if (!globalForDb.suiteSql) {
    // Ten connections is plenty for 50 people on a 2 vCPU server.
    globalForDb.suiteSql = postgres(env().databaseUrl, { max: 10, idle_timeout: 60, onnotice: () => {} });
  }
  return globalForDb.suiteSql;
}

let dbInstance: Db | undefined;

export function db(): Db {
  dbInstance ??= drizzle(sqlClient());
  return dbInstance;
}

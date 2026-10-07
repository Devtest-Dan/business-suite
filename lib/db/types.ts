import { customType } from "drizzle-orm/pg-core";

/** Postgres tsvector, for full-text search columns (usually generated). */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

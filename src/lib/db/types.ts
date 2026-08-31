import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "@/lib/db/schema";

export type DatabaseHealth = {
  ok: boolean;
  detail: string;
};

export type LocalDatabase = {
  file: string;
  sqlite: Database.Database;
  drizzle?: BetterSQLite3Database<typeof schema>;
  close(): void;
};

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrateDatabase } from "@/lib/db/migrations";
import * as schema from "@/lib/db/schema";
import type { DatabaseHealth, LocalDatabase } from "@/lib/db/types";

export function openDatabase(file: string): LocalDatabase {
  mkdirSync(dirname(file), { recursive: true });

  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db: LocalDatabase = {
    file,
    sqlite,
    drizzle: drizzle(sqlite, { schema }),
    close() {
      sqlite.close();
    },
  };

  const migrationResult = migrateDatabase(db);
  if (migrationResult instanceof Promise) {
    db.close();
    throw new Error("DATABASE_REQUIRES_ASYNC_MIGRATION");
  }

  return db;
}

export function checkDatabase(db: LocalDatabase): DatabaseHealth {
  if (db.sqlite.pragma("foreign_keys", { simple: true }) !== 1) {
    return { ok: false, detail: "foreign_keys pragma is disabled" };
  }

  if (db.sqlite.pragma("quick_check", { simple: true }) !== "ok") {
    return { ok: false, detail: "quick_check failed" };
  }

  const foreignKeyViolations = db.sqlite.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    return { ok: false, detail: "foreign_key_check found violations" };
  }

  return { ok: true, detail: "ok" };
}

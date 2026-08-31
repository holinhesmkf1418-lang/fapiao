/* @vitest-environment node */

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkDatabase, openDatabase } from "@/lib/db/client";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createLegacyDatabase(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });

  const sqlite = new Database(file);
  sqlite.exec(`
    create table schema_migrations (
      version integer primary key not null
    );
    insert into schema_migrations (version) values (0);
    create table legacy_notes (
      id text primary key not null,
      note text not null
    );
    insert into legacy_notes (id, note) values ('note-1', 'keep me');
  `);
  sqlite.close();
}

it("opens a WAL database with foreign keys and migrates once", async () => {
  // Regression guard: a fresh workspace must always boot into a usable SQLite file.
  const tempRoot = await mkdtemp(join(tmpdir(), "invoice-db-client-"));
  cleanupRoots.push(tempRoot);

  const db = await openDatabase(join(tempRoot, "workbench.sqlite"));

  expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.sqlite.prepare("select version from schema_migrations").get()).toEqual({
    version: 1,
  });
  expect(checkDatabase(db)).toEqual({ ok: true, detail: "ok" });

  db.close();
});

it("reports a failed health check when foreign keys are disabled after open", async () => {
  // Regression guard: health checks must catch sessions that silently lose FK enforcement.
  const tempRoot = await mkdtemp(join(tmpdir(), "invoice-db-health-"));
  cleanupRoots.push(tempRoot);

  const db = await openDatabase(join(tempRoot, "workbench.sqlite"));
  db.sqlite.pragma("foreign_keys = OFF");

  expect(checkDatabase(db)).toEqual({
    ok: false,
    detail: "foreign_keys pragma is disabled",
  });

  db.close();
});

it("upgrades a legacy database through the public openDatabase API and preserves a readable backup", async () => {
  // Regression guard: public startup must await legacy backup+migration instead of closing the connection mid-backup.
  const tempRoot = await mkdtemp(join(tmpdir(), "invoice-db-legacy-open-"));
  cleanupRoots.push(tempRoot);

  const legacyFile = join(tempRoot, "workspace", "data", "workbench.sqlite");
  await createLegacyDatabase(legacyFile);

  const db = await openDatabase(legacyFile);

  expect(db.sqlite.open).toBe(true);
  expect(db.sqlite.prepare("select version from schema_migrations").get()).toEqual({
    version: 1,
  });
  expect(
    db.sqlite.prepare("select note from legacy_notes where id = ?").get("note-1"),
  ).toEqual({ note: "keep me" });
  expect(checkDatabase(db)).toEqual({ ok: true, detail: "ok" });

  const backupFiles = await readdir(join(tempRoot, "workspace", "backups"));
  expect(backupFiles).toHaveLength(1);

  const backup = new Database(join(tempRoot, "workspace", "backups", backupFiles[0]), {
    readonly: true,
    fileMustExist: true,
  });

  expect(backup.prepare("select version from schema_migrations").get()).toEqual({
    version: 0,
  });
  expect(backup.prepare("select note from legacy_notes where id = ?").get("note-1")).toEqual({
    note: "keep me",
  });

  backup.close();
  db.close();
});

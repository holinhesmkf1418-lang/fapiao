/* @vitest-environment node */

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { migrateDatabase } from "@/lib/db/migrations";
import type { LocalDatabase } from "@/lib/db/types";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function createLocalDatabase(file: string): LocalDatabase {
  const sqlite = new Database(file);

  return {
    file,
    sqlite,
    close() {
      sqlite.close();
    },
  };
}

it("creates the v1 tables once even when migrations are re-run", async () => {
  // Regression guard: app restarts must not duplicate schema metadata or skip required tables.
  const tempRoot = await mkdtemp(join(tmpdir(), "invoice-db-migrate-"));
  cleanupRoots.push(tempRoot);

  const db = openDatabase(join(tempRoot, "workbench.sqlite"));
  migrateDatabase(db);

  const tables = db.sqlite
    .prepare<[], { name: string }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all()
    .map((row) => row.name);

  expect(tables).toEqual([
    "deletion_recoveries",
    "duplicate_matches",
    "export_jobs",
    "invoice_drafts",
    "invoices",
    "local_jobs",
    "recognition_jobs",
    "schema_migrations",
    "settings",
    "source_files",
    "status_events",
  ]);
  expect(db.sqlite.prepare("select count(*) as count from schema_migrations").get()).toEqual({
    count: 1,
  });
  expect(db.sqlite.prepare("select version from schema_migrations").get()).toEqual({
    version: 1,
  });

  db.close();
});

it("rejects invalid status values and preserves integer cents exactly", async () => {
  // Regression guard: persistence must block impossible states and never round monetary values.
  const tempRoot = await mkdtemp(join(tmpdir(), "invoice-db-constraints-"));
  cleanupRoots.push(tempRoot);

  const db = openDatabase(join(tempRoot, "workbench.sqlite"));

  db.sqlite
    .prepare(
      "insert into source_files (id, file_name, absolute_path, sha256, file_size_bytes, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "file-1",
      "invoice.pdf",
      "/tmp/invoice.pdf",
      "a".repeat(64),
      2048,
      "2026-08-31T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
    );

  db.sqlite
    .prepare(
      "insert into invoices (id, source_file_id, invoice_code, invoice_number, issued_at, seller_name, total_amount_cents, currency_code, reimbursement_status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "invoice-1",
      "file-1",
      "CODE-001",
      "NO-001",
      "2026-08-31T00:00:00.000Z",
      "Vendor",
      128000,
      "CNY",
      "pending",
      "2026-08-31T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
    );

  expect(
    db.sqlite.prepare("select total_amount_cents from invoices where id = ?").get("invoice-1"),
  ).toEqual({ total_amount_cents: 128000 });

  expect(() =>
    db.sqlite
      .prepare(
        "insert into invoices (id, source_file_id, invoice_code, invoice_number, issued_at, seller_name, total_amount_cents, currency_code, reimbursement_status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "invoice-2",
        "file-1",
        "CODE-002",
        "NO-002",
        "2026-08-31T00:00:00.000Z",
        "Vendor",
        500,
        "CNY",
        "settled",
        "2026-08-31T00:00:00.000Z",
        "2026-08-31T00:00:00.000Z",
      ),
  ).toThrowError(/CHECK constraint failed/i);

  expect(() =>
    db.sqlite
      .prepare(
        "insert into local_jobs (id, kind, payload_json, status, error_code, attempt_count, created_at, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "job-1",
        "sync",
        "{\"fileId\":\"file-1\"}",
        "queued",
        null,
        0,
        "2026-08-31T00:00:00.000Z",
        null,
        null,
      ),
  ).toThrowError(/CHECK constraint failed/i);

  db.close();
});

it("creates a pre-migration backup only for an existing older schema", async () => {
  // Regression guard: upgrades must snapshot existing user data without creating junk backups on first boot.
  const tempRoot = await mkdtemp(join(tmpdir(), "invoice-db-backup-"));
  cleanupRoots.push(tempRoot);

  const freshDb = openDatabase(join(tempRoot, "fresh", "workbench.sqlite"));
  freshDb.close();

  const freshBackupEntries = await readdir(join(tempRoot, "fresh", "backups")).catch(() => []);
  expect(freshBackupEntries).toEqual([]);

  const legacyFile = join(tempRoot, "legacy", "data", "workbench.sqlite");
  await mkdir(dirname(legacyFile), { recursive: true });
  const legacyDb = createLocalDatabase(legacyFile);
  legacyDb.sqlite.exec(`
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
  legacyDb.close();

  const upgradedDb = createLocalDatabase(legacyFile);
  await migrateDatabase(upgradedDb);

  const backupFiles = await readdir(join(tempRoot, "legacy", "backups"));
  expect(backupFiles).toHaveLength(1);
  expect(backupFiles[0]).toMatch(/^pre-migration-\d{8}T\d{6}Z\.sqlite$/);
  expect(
    upgradedDb.sqlite.prepare("select note from legacy_notes where id = ?").get("note-1"),
  ).toEqual({ note: "keep me" });
  expect(upgradedDb.sqlite.prepare("select version from schema_migrations").get()).toEqual({
    version: 1,
  });

  upgradedDb.close();
});

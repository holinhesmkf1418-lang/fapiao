import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type Database from "better-sqlite3";
import type { LocalDatabase } from "@/lib/db/types";

const CURRENT_SCHEMA_VERSION = 1;

const CREATE_V1_SCHEMA_SQL = `
create table if not exists schema_migrations (
  version integer primary key not null
);

create table if not exists settings (
  key text primary key not null,
  value_json text not null,
  updated_at text not null
);

create table if not exists source_files (
  id text primary key not null,
  file_name text not null,
  absolute_path text not null,
  sha256 text not null check (length(sha256) = 64),
  mime_type text,
  file_size_bytes integer not null check (file_size_bytes >= 0),
  created_at text not null check (created_at glob '????-??-??T??:??:??*Z'),
  updated_at text not null check (updated_at glob '????-??-??T??:??:??*Z')
);
create unique index if not exists source_files_absolute_path_idx on source_files (absolute_path);
create unique index if not exists source_files_sha256_idx on source_files (sha256);

create table if not exists recognition_jobs (
  id text primary key not null,
  source_file_id text not null references source_files(id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  provider text,
  request_payload_json text,
  result_json text,
  error_code text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at text not null check (created_at glob '????-??-??T??:??:??*Z'),
  started_at text check (started_at is null or started_at glob '????-??-??T??:??:??*Z'),
  finished_at text check (finished_at is null or finished_at glob '????-??-??T??:??:??*Z')
);
create index if not exists recognition_jobs_source_file_id_idx on recognition_jobs (source_file_id);

create table if not exists invoice_drafts (
  id text primary key not null,
  source_file_id text not null references source_files(id) on delete cascade,
  recognition_job_id text references recognition_jobs(id) on delete set null,
  status text not null check (status in ('draft', 'confirmed')),
  payload_json text not null,
  created_at text not null check (created_at glob '????-??-??T??:??:??*Z'),
  updated_at text not null check (updated_at glob '????-??-??T??:??:??*Z')
);
create index if not exists invoice_drafts_source_file_id_idx on invoice_drafts (source_file_id);

create table if not exists invoices (
  id text primary key not null,
  source_file_id text not null references source_files(id) on delete cascade,
  invoice_draft_id text references invoice_drafts(id) on delete set null,
  invoice_code text not null,
  invoice_number text not null,
  issued_at text not null check (issued_at glob '????-??-??T??:??:??*Z'),
  seller_name text not null,
  buyer_name text,
  total_amount_cents integer not null,
  tax_amount_cents integer,
  currency_code text not null,
  reimbursement_status text not null check (reimbursement_status in ('pending', 'reimbursing', 'reimbursed')),
  created_at text not null check (created_at glob '????-??-??T??:??:??*Z'),
  updated_at text not null check (updated_at glob '????-??-??T??:??:??*Z')
);
create index if not exists invoices_source_file_id_idx on invoices (source_file_id);

create table if not exists duplicate_matches (
  id text primary key not null,
  invoice_id text not null references invoices(id) on delete cascade,
  duplicate_invoice_id text not null references invoices(id) on delete cascade,
  match_reason text not null,
  created_at text not null check (created_at glob '????-??-??T??:??:??*Z'),
  check (invoice_id <> duplicate_invoice_id)
);
create unique index if not exists duplicate_matches_pair_idx on duplicate_matches (invoice_id, duplicate_invoice_id);

create table if not exists export_jobs (
  id text primary key not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  target_format text not null,
  payload_json text not null,
  output_path text,
  error_code text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at text not null check (created_at glob '????-??-??T??:??:??*Z'),
  started_at text check (started_at is null or started_at glob '????-??-??T??:??:??*Z'),
  finished_at text check (finished_at is null or finished_at glob '????-??-??T??:??:??*Z')
);

create table if not exists status_events (
  id text primary key not null,
  entity_kind text not null,
  entity_id text not null,
  status text not null,
  detail_json text,
  created_at text not null check (created_at glob '????-??-??T??:??:??*Z')
);

create table if not exists deletion_recoveries (
  id text primary key not null,
  entity_kind text not null,
  entity_id text not null,
  snapshot_json text not null,
  deleted_at text not null check (deleted_at glob '????-??-??T??:??:??*Z'),
  recovered_at text check (recovered_at is null or recovered_at glob '????-??-??T??:??:??*Z')
);

create table if not exists local_jobs (
  id text primary key not null,
  kind text not null check (kind in ('recognition', 'export', 'maintenance')),
  payload_json text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  error_code text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at text not null check (created_at glob '????-??-??T??:??:??*Z'),
  started_at text check (started_at is null or started_at glob '????-??-??T??:??:??*Z'),
  finished_at text check (finished_at is null or finished_at glob '????-??-??T??:??:??*Z')
);
`;

function tableExists(sqlite: Database.Database, tableName: string): boolean {
  const row = sqlite
    .prepare<[string], { name: string }>(
      "select name from sqlite_master where type = 'table' and name = ?",
    )
    .get(tableName);

  return row?.name === tableName;
}

function readSchemaVersion(sqlite: Database.Database): number {
  if (!tableExists(sqlite, "schema_migrations")) {
    return 0;
  }

  const row = sqlite
    .prepare<[], { version: number | null }>("select max(version) as version from schema_migrations")
    .get();

  return row?.version ?? 0;
}

function deriveWorkRoot(databaseFile: string): string {
  const parentDir = dirname(databaseFile);
  if (basename(parentDir) === "data") {
    return dirname(parentDir);
  }

  return parentDir;
}

function formatBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function backupDatabase(db: LocalDatabase): Promise<void> {
  const backupDir = join(deriveWorkRoot(db.file), "backups");
  mkdirSync(backupDir, { recursive: true });

  const backupFile = join(
    backupDir,
    `pre-migration-${formatBackupTimestamp(new Date())}.sqlite`,
  );

  await db.sqlite.backup(backupFile);
}

function applyVersionOne(sqlite: Database.Database): void {
  sqlite.exec(CREATE_V1_SCHEMA_SQL);
  sqlite.prepare("delete from schema_migrations").run();
  sqlite.prepare("insert into schema_migrations (version) values (?)").run(CURRENT_SCHEMA_VERSION);
}

function runMigrationTransaction(db: LocalDatabase, currentVersion: number): void {
  const transaction = db.sqlite.transaction((version: number) => {
    if (version < 1) {
      applyVersionOne(db.sqlite);
    }
  });

  transaction.immediate(currentVersion);
}

export async function migrateDatabase(db: LocalDatabase): Promise<void> {
  const currentVersion = readSchemaVersion(db.sqlite);
  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    return;
  }

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error("UNSUPPORTED_SCHEMA_VERSION");
  }

  const hasExistingSchema = tableExists(db.sqlite, "schema_migrations");

  if (hasExistingSchema) {
    await backupDatabase(db);
    runMigrationTransaction(db, currentVersion);
    return;
  }

  runMigrationTransaction(db, currentVersion);
}

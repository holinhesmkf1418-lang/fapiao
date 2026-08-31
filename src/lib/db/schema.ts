import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const jobStatusCheck = ["queued", "running", "succeeded", "failed"] as const;
const draftStatusCheck = ["draft", "confirmed"] as const;
const reimbursementStatusCheck = ["pending", "reimbursing", "reimbursed"] as const;
const localJobKindCheck = ["recognition", "export", "maintenance"] as const;

function membershipCheck(name: string, columnName: string, values: readonly string[]) {
  const literals = values.map((value) => sql.raw(`'${value}'`));

  return check(name, sql`${sql.identifier(columnName)} in (${sql.join(literals, sql`, `)})`);
}

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sourceFiles = sqliteTable(
  "source_files",
  {
    id: text("id").primaryKey(),
    fileName: text("file_name").notNull(),
    absolutePath: text("absolute_path").notNull(),
    sha256: text("sha256").notNull(),
    mimeType: text("mime_type"),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("source_files_absolute_path_idx").on(table.absolutePath),
    uniqueIndex("source_files_sha256_idx").on(table.sha256),
    check("source_files_file_size_bytes_check", sql`${table.fileSizeBytes} >= 0`),
  ],
);

export const recognitionJobs = sqliteTable(
  "recognition_jobs",
  {
    id: text("id").primaryKey(),
    sourceFileId: text("source_file_id")
      .notNull()
      .references(() => sourceFiles.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    provider: text("provider"),
    requestPayloadJson: text("request_payload_json"),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    membershipCheck("recognition_jobs_status_check", "status", jobStatusCheck),
    check("recognition_jobs_attempt_count_check", sql`${table.attemptCount} >= 0`),
  ],
);

export const invoiceDrafts = sqliteTable(
  "invoice_drafts",
  {
    id: text("id").primaryKey(),
    sourceFileId: text("source_file_id")
      .notNull()
      .references(() => sourceFiles.id, { onDelete: "cascade" }),
    recognitionJobId: text("recognition_job_id").references(() => recognitionJobs.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  () => [membershipCheck("invoice_drafts_status_check", "status", draftStatusCheck)],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    sourceFileId: text("source_file_id")
      .notNull()
      .references(() => sourceFiles.id, { onDelete: "cascade" }),
    invoiceDraftId: text("invoice_draft_id").references(() => invoiceDrafts.id, {
      onDelete: "set null",
    }),
    invoiceCode: text("invoice_code").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    issuedAt: text("issued_at").notNull(),
    sellerName: text("seller_name").notNull(),
    buyerName: text("buyer_name"),
    totalAmountCents: integer("total_amount_cents").notNull(),
    taxAmountCents: integer("tax_amount_cents"),
    currencyCode: text("currency_code").notNull(),
    reimbursementStatus: text("reimbursement_status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  () => [
    membershipCheck(
      "invoices_reimbursement_status_check",
      "reimbursement_status",
      reimbursementStatusCheck,
    ),
  ],
);

export const duplicateMatches = sqliteTable(
  "duplicate_matches",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    duplicateInvoiceId: text("duplicate_invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    matchReason: text("match_reason").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("duplicate_matches_pair_idx").on(table.invoiceId, table.duplicateInvoiceId),
    check("duplicate_matches_distinct_invoice_check", sql`${table.invoiceId} <> ${table.duplicateInvoiceId}`),
  ],
);

export const exportJobs = sqliteTable(
  "export_jobs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    targetFormat: text("target_format").notNull(),
    payloadJson: text("payload_json").notNull(),
    outputPath: text("output_path"),
    errorCode: text("error_code"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    membershipCheck("export_jobs_status_check", "status", jobStatusCheck),
    check("export_jobs_attempt_count_check", sql`${table.attemptCount} >= 0`),
  ],
);

export const statusEvents = sqliteTable("status_events", {
  id: text("id").primaryKey(),
  entityKind: text("entity_kind").notNull(),
  entityId: text("entity_id").notNull(),
  status: text("status").notNull(),
  detailJson: text("detail_json"),
  createdAt: text("created_at").notNull(),
});

export const deletionRecoveries = sqliteTable("deletion_recoveries", {
  id: text("id").primaryKey(),
  entityKind: text("entity_kind").notNull(),
  entityId: text("entity_id").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  deletedAt: text("deleted_at").notNull(),
  recoveredAt: text("recovered_at"),
});

export const localJobs = sqliteTable(
  "local_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    membershipCheck("local_jobs_kind_check", "kind", localJobKindCheck),
    membershipCheck("local_jobs_status_check", "status", jobStatusCheck),
    check("local_jobs_attempt_count_check", sql`${table.attemptCount} >= 0`),
  ],
);

# 本地整理导出、备份与最终验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成按月份/类型整理的 Excel 与 ZIP，并完成本地备份、恢复、日志轮换和全产品验收。

**Architecture:** 导出任务先把筛选结果冻结为 SQLite 快照，再从同一快照生成 Excel 和复制后的规范文件树，最后原子发布 ZIP。备份使用 SQLite 在线备份 API；完整恢复先解包到临时目录并验证清单与哈希，再安全切换工作目录。

**Tech Stack:** Next.js、SQLite/better-sqlite3、ExcelJS、Archiver、Node.js streams、Zod、Vitest、Playwright

**Spec:** `docs/product-design.md`

## Global Constraints

- 文件名固定为 `日期-类型-开票方名称-发票号码.ext`。
- ZIP 固定按 `YYYY-MM/发票类型/` 建目录，并在根目录包含 Excel 明细。
- 同名强制保留副本依次追加 `-副本2`、`-副本3`。
- Excel 日期是日期单元格，金额是两位小数数值，首行冻结并启用筛选。
- 导出不会自动修改报销状态；缺少命名关键字段的发票不得进入成品。
- 自动元数据备份最多保留最近 7 份；迁移前备份不参与轮换。
- 完整备份不包含钥匙串密钥；恢复必须先验证结构和哈希。
- 每个 Task 通过验证后独立提交并运行 `git push origin HEAD`。

---

## File Structure

```text
src/lib/exports/filename.ts            # 安全命名和同名分配
src/lib/exports/snapshot.ts            # 筛选快照与预检
src/lib/exports/excel.ts               # Excel 明细生成
src/lib/exports/zip.ts                 # 月份/类型 ZIP 生成
src/lib/exports/service.ts             # 任务、进度、原子发布
src/lib/backups/metadata.ts            # 每日 SQLite 备份与 7 份轮换
src/lib/backups/full.ts                # 完整备份清单、哈希和压缩
src/lib/backups/restore.ts             # 临时解包、验证、安全切换
src/lib/maintenance/                   # 空间检查、临时文件和日志轮换
src/app/exports/                       # 整理导出页面
src/app/settings/backup/               # 备份恢复页面
```

## Shared Interfaces

```ts
export type ExportInvoice = {
  id: string; invoiceType: string; issueDate: string; invoiceCode: string | null;
  invoiceNumber: string | null; uniqueVoucherNumber: string | null; sellerName: string;
  buyerName: string | null; amountExcludingTaxCents: number | null; taxCents: number | null;
  totalAmountCents: number; reimbursementStatus: "pending" | "reimbursing" | "reimbursed";
  originalName: string; managedRelativePath: string; extension: string; recognizedAt: string;
};
export type ExportSnapshotItem = ExportInvoice & { exportRelativePath: string; exportFilename: string };
export type ExportSnapshot = { id: string; filtersJson: string; createdAt: string; items: ExportSnapshotItem[] };
export type ExportPreview = {
  snapshotId: string; count: number; amountCents: number; estimatedBytes: number;
  paths: string[]; blockers: Array<{ invoiceId: string; fields: string[] }>;
};
export type BackupResult = { created: boolean; path: string | null; rotated: string[] };
export type MaintenanceSummary = { backup: BackupResult; removedLogs: number; removedTemps: number };
export type BackupManifest = {
  version: 1; createdAt: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
};
```

`InvoiceFilters` is imported from `src/lib/invoices/filters.ts`, completed in the management plan; all export selection uses that exact parser.

### Task 1: 安全文件命名与同名分配

**Files:**
- Create: `src/lib/exports/filename.ts`, `src/lib/exports/types.ts`
- Test: `tests/lib/exports/filename.test.ts`

**Interfaces:**
- Produces: `buildExportFilename(invoice: ExportInvoice): string`
- Produces: `allocateUniqueName(name: string, used: Set<string>): string`
- Produces: `sanitizePathSegment(value: string): string`

- [ ] **Step 1: Write failing naming examples**

```ts
it("uses the exact field order and keeps the original extension", () => {
  expect(buildExportFilename(invoice({ sellerName: "北京/示例:科技", extension: "PDF" })))
    .toBe("2026-08-28-增值税普通发票-北京 示例 科技-25112000000018475031.pdf");
});

it("adds deterministic copy suffixes", () => {
  const used = new Set(["a.pdf", "a-副本2.pdf"]);
  expect(allocateUniqueName("a.pdf", used)).toBe("a-副本3.pdf");
});
```

- [ ] **Step 2: Run naming tests and verify failure**

Run: `pnpm vitest run tests/lib/exports/filename.test.ts`

Expected: FAIL because filename functions are absent.

- [ ] **Step 3: Implement normalization and UTF-8 byte limits**

Replace `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|` and control characters with spaces, collapse whitespace, trim dots/spaces, and reject `.`/`..`. Preserve date, type and invoice/voucher number; shorten seller by Unicode code point until the complete basename is at most 220 UTF-8 bytes. Use `uniqueVoucherNumber` only when `invoiceNumber` is null.

- [ ] **Step 4: Verify Unicode, reserved characters and copies**

Run: `pnpm vitest run tests/lib/exports/filename.test.ts && pnpm typecheck`

Expected: PASS for Chinese, emoji, long seller names, missing invoice number fallback, and three duplicate copies.

- [ ] **Step 5: Commit and push naming rules**

```bash
git add src/lib/exports tests/lib/exports/filename.test.ts
git commit -m "feat: add safe invoice export filenames"
git push origin HEAD
```

### Task 2: 导出筛选快照与预检

**Files:**
- Create: `src/lib/exports/snapshot.ts`, `src/lib/exports/repository.ts`
- Create: `src/app/api/exports/preview/route.ts`
- Test: `tests/lib/exports/snapshot.test.ts`, `tests/app/api/export-preview.test.ts`

**Interfaces:**
- Produces: `createExportSnapshot(filters: InvoiceFilters): Promise<ExportSnapshot>`
- Produces: `previewExport(filters): Promise<ExportPreview>`
- Produces: `POST /api/exports/preview`

- [ ] **Step 1: Write failing immutable snapshot tests**

```ts
it("freezes selected invoice values before later edits", async () => {
  const snapshot = await createExportSnapshot({ month: "2026-08", types: [], statuses: [] });
  await renameSeller("invoice-a", "后来修改的名称");
  expect((await readSnapshot(snapshot.id)).items[0].sellerName).toBe("原始名称");
});

it("reports missing naming fields instead of silently skipping", async () => {
  const preview = await previewExport(filtersForMissingSeller);
  expect(preview.blockers).toEqual([{ invoiceId: "invoice-a", fields: ["sellerName"] }]);
});
```

- [ ] **Step 2: Run snapshot/preview tests**

Run: `pnpm vitest run tests/lib/exports/snapshot.test.ts tests/app/api/export-preview.test.ts`

Expected: FAIL because snapshot and preview services are missing.

- [ ] **Step 3: Implement snapshot rows and exact preview totals**

In one read transaction select the filtered invoice IDs and copy all Excel/name fields into export snapshot rows. Preview returns `count`, `amountCents`, directory/name list, blocker list and estimated source bytes. If the selection is empty return `EMPTY_EXPORT`; if any blocker exists the later create endpoint must reject the snapshot.

- [ ] **Step 4: Reconcile preview with dashboard/list filters**

Run: `pnpm vitest run tests/lib/exports/snapshot.test.ts tests/app/api/export-preview.test.ts tests/lib/dashboard/query.test.ts && pnpm typecheck`

Expected: PASS; preview count and cents equal the dashboard for identical filters.

- [ ] **Step 5: Commit and push export preview**

```bash
git add src/lib/exports src/app/api/exports/preview tests/lib/exports tests/app/api/export-preview.test.ts
git commit -m "feat: preview immutable invoice exports"
git push origin HEAD
```

### Task 3: Excel 明细生成

**Files:**
- Create: `src/lib/exports/excel.ts`, `src/lib/exports/excel-columns.ts`
- Test: `tests/lib/exports/excel.test.ts`

**Interfaces:**
- Produces: `writeInvoiceWorkbook(snapshot: ExportSnapshot, output: string): Promise<void>`
- Produces fixed column order from the product design

- [ ] **Step 1: Write failing workbook content tests**

```ts
it("writes real dates, numeric money, filters, and frozen header", async () => {
  await writeInvoiceWorkbook(snapshot, output);
  const sheet = await loadFirstSheet(output);
  expect(sheet.getRow(1).values).toEqual([undefined, "发票类型", "开票日期", "发票代码", "发票号码", "开票方名称", "购买方名称", "不含税金额", "税额", "价税合计", "报销状态", "原文件名", "导出文件名", "识别时间"]);
  expect(sheet.getCell("B2").value).toBeInstanceOf(Date);
  expect(sheet.getCell("I2").value).toBe(1280);
  expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  expect(sheet.autoFilter).toBe("A1:M2");
});
```

- [ ] **Step 2: Run workbook test and observe failure**

Run: `pnpm vitest run tests/lib/exports/excel.test.ts`

Expected: FAIL because the workbook writer does not exist.

- [ ] **Step 3: Implement fixed columns and cents conversion at the edge**

Write one worksheet named `发票明细`. Convert cents to yuan only when assigning Excel values with `cents / 100`; apply number format `¥#,##0.00` and date format `yyyy-mm-dd`. Use the already allocated export filename from the snapshot so Excel and ZIP cannot disagree.

- [ ] **Step 4: Read the generated workbook back and assert it**

Run: `pnpm vitest run tests/lib/exports/excel.test.ts && pnpm typecheck`

Expected: PASS; row count equals snapshot item count and no merged cells exist.

- [ ] **Step 5: Commit and push Excel export**

```bash
git add src/lib/exports/excel.ts src/lib/exports/excel-columns.ts tests/lib/exports/excel.test.ts package.json pnpm-lock.yaml
git commit -m "feat: generate invoice excel details"
git push origin HEAD
```

### Task 4: ZIP 目录、任务进度与原子发布

**Files:**
- Create: `src/lib/exports/zip.ts`, `src/lib/exports/service.ts`, `src/lib/exports/job-handler.ts`
- Create: `src/app/api/exports/route.ts`, `src/app/api/exports/[id]/route.ts`, `src/app/api/exports/[id]/file/route.ts`
- Test: `tests/lib/exports/zip.test.ts`, `tests/lib/exports/service.test.ts`
- Test: `tests/app/api/exports.test.ts`

**Interfaces:**
- Produces: `createExport(snapshotId: string): Promise<{ jobId: string }>`
- Produces: `runExportJob(jobId: string): Promise<void>`
- Produces: ZIP `发票导出-<scope>.zip` in the work root `exports/`
- Produces: create/status/file APIs

- [ ] **Step 1: Write failing ZIP tree and cleanup tests**

```ts
it("contains one workbook and month/type invoice paths", async () => {
  const zip = await runFixtureExport();
  expect(await listZip(zip)).toEqual([
    "发票明细-2026-08.xlsx",
    "2026-08/火车票/2026-08-28-火车票-中国铁路-1234567890.pdf"
  ]);
});

it("does not publish a partial zip after stream failure", async () => {
  await expect(runBrokenExport()).rejects.toThrow("EXPORT_STREAM_FAILED");
  expect(await globExports("*.partial")).toEqual([]);
  expect(await globExports("*.zip")).toEqual([]);
});
```

- [ ] **Step 2: Run ZIP and service tests**

Run: `pnpm vitest run tests/lib/exports/zip.test.ts tests/lib/exports/service.test.ts tests/app/api/exports.test.ts`

Expected: FAIL because ZIP/service modules are absent.

- [ ] **Step 3: Implement stream-based local packaging**

Check free space against estimated source bytes plus 25% and 50 MiB. Create a job temp directory, write Excel, stream managed copies to Archiver under allocated paths, finalize and fsync a `.partial`, then atomically rename it to `.zip`. Store progress as completed item count/total. On failure remove the task temp directory and `.partial`, preserve the immutable snapshot, and mark the job retryable.

- [ ] **Step 4: Verify ZIP, status and protected file route**

Run: `pnpm vitest run tests/lib/exports tests/app/api/exports.test.ts && pnpm typecheck`

Expected: PASS; traversal names cannot escape the archive and the file route only serves completed jobs inside `exports/`.

- [ ] **Step 5: Commit and push local ZIP generation**

```bash
git add src/lib/exports src/app/api/exports tests/lib/exports tests/app/api/exports.test.ts package.json pnpm-lock.yaml
git commit -m "feat: package organized invoice exports"
git push origin HEAD
```

### Task 5: 整理导出页面

**Files:**
- Create: `src/app/exports/page.tsx`
- Create: `src/components/exports/export-filters.tsx`, `src/components/exports/export-preview.tsx`
- Create: `src/components/exports/export-progress.tsx`, `src/components/exports/export-result.tsx`
- Create: `src/lib/client/export-api.ts`
- Test: `tests/components/exports/export-page.test.tsx`, `tests/e2e/export.spec.ts`

**Interfaces:**
- Consumes: preview, create, status and file APIs
- Produces: `pnpm test:e2e --grep @export`

- [ ] **Step 1: Write failing preview-blocker UI test**

```tsx
it("blocks generation and links to invoices with missing fields", async () => {
  render(<ExportPage initialPreview={previewWithBlocker} />);
  expect(screen.getByRole("button", { name: "生成 Excel 和 ZIP" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "修正 1 张发票" })).toHaveAttribute("href", "/invoices?ids=invoice-a");
});
```

- [ ] **Step 2: Run export page test and observe failure**

Run: `pnpm vitest run tests/components/exports/export-page.test.tsx`

Expected: FAIL because export components do not exist.

- [ ] **Step 3: Implement preview-first task UI**

Allow month, type and status selection. Show count, amount, estimated size and the exact folder/name tree before enabling generation. Default destination is the work root `exports/`; `选择其他目录` invokes the macOS folder chooser and passes back a server-issued directory handle, never a browser-supplied absolute path. Poll a queued/running job at 1 second; on success display `在 Finder 中显示` and protected download/open actions. Do not change reimbursement status anywhere in this flow.

- [ ] **Step 4: Add and run export journey**

```ts
test("@export previews and generates an organized zip", async ({ page }) => {
  await page.goto("/exports");
  await page.getByLabel("月份").selectOption("2026-08");
  await page.getByRole("button", { name: "预览整理结果" }).click();
  await expect(page.getByText("2026-08/火车票")).toBeVisible();
  await page.getByRole("button", { name: "生成 Excel 和 ZIP" }).click();
  await expect(page.getByText("导出完成")).toBeVisible();
});
```

Run: `pnpm vitest run tests/components/exports && pnpm test:e2e --grep @export`

Expected: PASS at desktop and narrow viewport.

- [ ] **Step 5: Commit and push export UI**

```bash
git add src/app/exports src/components/exports src/lib/client/export-api.ts tests/components/exports tests/e2e/export.spec.ts
git commit -m "feat: add organized export workspace"
git push origin HEAD
```

### Task 6: 每日元数据备份与 7 份轮换

**Files:**
- Create: `src/lib/backups/types.ts`, `src/lib/backups/metadata.ts`
- Create: `src/lib/maintenance/logs.ts`, `src/lib/maintenance/temp-files.ts`
- Test: `tests/lib/backups/metadata.test.ts`, `tests/lib/maintenance/cleanup.test.ts`
- Modify: `src/lib/runtime/context.ts`

**Interfaces:**
- Produces: `ensureDailyMetadataBackup(now: Date): Promise<BackupResult>`
- Produces: `rotateAutomaticBackups(keep: 7): Promise<string[]>`
- Produces: `runStartupMaintenance(now: Date): Promise<MaintenanceSummary>`

- [ ] **Step 1: Write failing backup retention tests**

```ts
it("creates at most one daily backup and keeps seven automatic files", async () => {
  await seedAutomaticBackups(7);
  await ensureDailyMetadataBackup(new Date("2026-08-31T08:00:00+08:00"));
  await ensureDailyMetadataBackup(new Date("2026-08-31T18:00:00+08:00"));
  expect(await automaticBackups()).toHaveLength(7);
  expect(await integrityOfNewestBackup()).toBe("ok");
  expect(await preMigrationBackups()).toHaveLength(1);
});
```

- [ ] **Step 2: Run backup/maintenance tests**

Run: `pnpm vitest run tests/lib/backups tests/lib/maintenance`

Expected: FAIL because backup and maintenance modules are missing.

- [ ] **Step 3: Implement online backup and scoped cleanup**

Run `PRAGMA quick_check` first; if it fails, do not rotate any backup. Use better-sqlite3 backup into a same-directory temp file, verify the new copy, then rename to `metadata-YYYY-MM-DD.sqlite`. Rotate only files matching that exact automatic pattern. Remove logs older than 7 days and orphan `.partial`/`.tmp` files older than 24 hours only inside authorized logs/export/temp directories.

- [ ] **Step 4: Verify corrupt DB and path-scope cases**

Run: `pnpm vitest run tests/lib/backups tests/lib/maintenance && pnpm typecheck`

Expected: PASS; corrupt current DB preserves all prior backups and cleanup never follows outside symlinks.

- [ ] **Step 5: Commit and push automatic maintenance**

```bash
git add src/lib/backups src/lib/maintenance src/lib/runtime/context.ts tests/lib/backups tests/lib/maintenance
git commit -m "feat: add local backup and maintenance rotation"
git push origin HEAD
```

### Task 7: 完整备份、验证恢复与设置页面

**Files:**
- Create: `src/lib/backups/manifest.ts`, `src/lib/backups/full.ts`, `src/lib/backups/restore.ts`
- Create: `src/app/api/backups/route.ts`, `src/app/api/backups/restore/route.ts`
- Create: `src/app/settings/backup/page.tsx`, `src/components/backups/backup-panel.tsx`
- Test: `tests/lib/backups/full.test.ts`, `tests/lib/backups/restore.test.ts`
- Test: `tests/e2e/backup-restore.spec.ts`

**Interfaces:**
- Produces: `createFullBackup(destination: string): Promise<string>`
- Produces: `validateFullBackup(archive: string): Promise<BackupManifest>`
- Produces: `restoreFullBackup(archive: string): Promise<{ previousRoot: string }>`
- Produces manifest version 1 with relative path, bytes, and SHA-256 for every payload file

- [ ] **Step 1: Write failing manifest and rollback tests**

```ts
it("excludes runtime files and keychain secrets from a full backup", async () => {
  const archive = await createFullBackup(destination);
  const names = await listZip(archive);
  expect(names).toContain("manifest.json");
  expect(names).toContain("data/workbench.sqlite");
  expect(names).not.toContain("runtime.json");
  expect(await zipContainsText(archive, fakeSecretKey)).toBe(false);
});

it("leaves the current root untouched when a hash is wrong", async () => {
  await expect(restoreFullBackup(tamperedArchive)).rejects.toThrow("BACKUP_HASH_MISMATCH");
  expect(await currentRootMarker()).toBe("original");
});
```

- [ ] **Step 2: Run full backup tests and verify failure**

Run: `pnpm vitest run tests/lib/backups/full.test.ts tests/lib/backups/restore.test.ts`

Expected: FAIL because full backup/restore modules are absent.

- [ ] **Step 3: Implement validated staging and safe root switch**

Create a consistent SQLite copy first, stream it plus managed invoices and non-sensitive config into a ZIP with `manifest.json`. Restore into a sibling staging directory, reject duplicate paths/traversal/symlinks/hash or size mismatches, open the staged DB read-only and run integrity checks. Stop task intake, rename current root to `<name>.before-restore-<timestamp>`, rename staging to the configured root, reopen runtime context; if the second rename/reopen fails, restore the prior root.

- [ ] **Step 4: Implement the explicit backup/restore UI and journey**

The restore dialog names the archive and explains that the current root will be kept as a timestamped safety copy. Use the macOS folder/file chooser through the launcher/native bridge; the browser never supplies arbitrary absolute paths.

Run: `pnpm vitest run tests/lib/backups && pnpm test:e2e --grep @backup && pnpm typecheck`

Expected: PASS; restored invoice count/files equal the manifest and the prior root remains available.

- [ ] **Step 5: Commit and push backup/restore**

```bash
git add src/lib/backups src/app/api/backups src/app/settings/backup src/components/backups tests/lib/backups tests/e2e/backup-restore.spec.ts native/InvoiceNative
git commit -m "feat: add verified full backup and restore"
git push origin HEAD
```

### Task 8: 最终闭环、真实样本报告与发布门禁

**Files:**
- Create: `tests/e2e/full-workbench.spec.ts`
- Create: `scripts/evaluate-recognition.mjs`
- Create: `docs/recognition-benchmark.md`
- Create: `docs/local-release-checklist.md`
- Modify: `README.md`, `package.json`

**Interfaces:**
- Produces: `pnpm benchmark:recognition --fixtures <private-fixture-dir>`
- Produces: `pnpm verify:release`

- [ ] **Step 1: Write the failing full local journey**

```ts
test("@release completes import through export without external traffic", async ({ page }) => {
  blockAllNonLoopbackRequests(page);
  await importAndConfirm(page, "tests/fixtures/invoices/minimal.pdf");
  await updateStatus(page, "报销中");
  await expectDashboardToReconcile(page);
  const zip = await exportCurrentMonth(page);
  await expectZipAndWorkbookToReconcile(zip);
});
```

- [ ] **Step 2: Run the release journey and record its first failure**

Run: `pnpm test:e2e --grep @release`

Expected: FAIL until the complete fixture helpers and reconciliation assertions are wired.

- [ ] **Step 3: Implement benchmark and release checks**

The benchmark accepts a user-owned private fixture directory with a JSON truth file, computes exact-match rates for type/date/number/seller/total, and writes only aggregate counts to `docs/recognition-benchmark.md`; it never commits invoice samples or OCR text. `verify:release` runs lint, typecheck, unit tests, production build, all E2E tags, Swift tests, `git diff --check`, loopback listener inspection, and a scan for secret-like values.

- [ ] **Step 4: Run all automated and manual acceptance checks**

Run: `pnpm verify:release`

Expected: exit 0; no external request occurs in the local journey; all product totals reconcile.

Manual checks:

1. Finder double-click install/start/start/close.
2. Upload one real PDF text invoice, one scan/image, and one OFD.
3. Confirm the local OCR result, then explicitly test one cloud fallback only if credentials are configured.
4. Export and open the resulting Excel/ZIP in Finder.
5. Create and validate one full backup without replacing the active root.

- [ ] **Step 5: Update concise operating documentation**

Document exact double-click usage, supported formats/limits, work directory, local-first privacy rule, cloud confirmation cost warning, backup recovery, and how to locate logs without including invoice content.

- [ ] **Step 6: Commit and push the release gate**

```bash
git add tests/e2e/full-workbench.spec.ts scripts/evaluate-recognition.mjs docs/recognition-benchmark.md docs/local-release-checklist.md README.md package.json pnpm-lock.yaml
git commit -m "test: verify complete local invoice workflow"
git push origin HEAD
```

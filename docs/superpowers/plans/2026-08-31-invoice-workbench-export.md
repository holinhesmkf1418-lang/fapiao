# 发票整理导出与最终验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付导出预检、规范命名、Excel 明细、月份/类型 ZIP 目录、异步生成、限时下载和完整 MVP 验收。

**Architecture:** 创建导出任务时把筛选结果快照为发票 ID，避免生成期间数据变化。后台 worker 逐项读取私有原始文件，流式生成 Excel 与 ZIP 并写入对象存储；完成后只返回短期签名下载地址，导出包保存 24 小时后自动清理。

**Tech Stack:** Next.js 16、PostgreSQL、Drizzle ORM、pg-boss、ExcelJS、Archiver、AWS SDK v3 multipart upload、Vitest、Playwright

**Spec:** `docs/product-design.md`

## Global Constraints

- 导出名称固定为 `日期-类型-开票方名称-发票号码.ext`。
- ZIP 固定按 `YYYY-MM/标准票种/文件` 组织，根目录包含 Excel 明细。
- Excel 每张发票一行，金额为数值两位小数，日期为真实日期，首行冻结并启用筛选。
- 生成前必须阻止关键字段缺失的发票，不生成不完整文件名。
- 导出金额、行数和页面筛选必须使用同一批发票 ID 快照。
- 原始文件和 ZIP 不得公开；下载链接有效 15 分钟，ZIP 保存 24 小时。
- 大文件生成必须流式处理，禁止把整个 ZIP 读入内存。

---

### Task 1: 导出任务、快照与预检

**Files:**
- Modify: `src/db/schema/invoices.ts`
- Create: `drizzle/0004_export_jobs.sql` (generated)
- Create: `src/exports/types.ts`
- Create: `src/exports/create-export.ts`
- Create: `src/exports/create-export.test.ts`
- Create: `src/app/api/exports/preview/route.ts`
- Create: `src/app/api/exports/route.ts`

**Interfaces:**
- Consumes: `InvoiceFilters`、当前用户发票。
- Produces: `previewExport()`；`createExport()`；`export_jobs` 与 `export_job_items` 快照。

- [ ] **Step 1: 写预检和快照测试**

```ts
test("blocks invoices with missing naming fields", async () => {
  await seedInvoice({ userId: "u1", sellerName: "", invoiceNumber: "123" });
  const preview = await previewExport({ userId: "u1", filters: { month: "2026-08" } });
  expect(preview.canCreate).toBe(false);
  expect(preview.issues[0]).toMatchObject({ code: "MISSING_SELLER_NAME" });
});

test("snapshots selected invoice ids", async () => {
  const invoice = await seedInvoice({ userId: "u1", date: "2026-08-01" });
  const job = await createExport({ userId: "u1", filters: { month: "2026-08" } });
  await seedInvoice({ userId: "u1", date: "2026-08-02" });
  expect(await getExportItemIds(job.id)).toEqual([invoice.id]);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/exports/create-export.test.ts`

Expected: FAIL，导出模块不存在。

- [ ] **Step 3: 定义 schema 与返回类型**

```ts
export type ExportPreview = {
  canCreate: boolean;
  invoiceCount: number;
  totalAmount: string;
  estimatedBytes: number;
  issues: Array<{ invoiceId: string; code: "MISSING_DATE" | "MISSING_TYPE" | "MISSING_SELLER_NAME" | "MISSING_INVOICE_NUMBER" | "SOURCE_FILE_MISSING"; message: string }>;
};

export type ExportJobState = "queued" | "generating" | "ready" | "failed" | "expired";
```

`export_jobs` stores user ID, state, serialized validated filters, invoice count, total amount, output storage key, size, failure code/message, created/started/completed/expires timestamps. `export_job_items` has composite primary key `(export_job_id, invoice_id)` and preserves deterministic order by invoice date, type, seller, invoice number. Creation and item insertion occur in one transaction after ownership and issue validation.

Before creation, count the user's jobs in `queued|generating`; reject with `RATE_LIMITED` when three already exist. This check and job insertion must share one transaction-level advisory lock keyed by user ID so concurrent requests cannot exceed the limit.

- [ ] **Step 4: 生成 migration 并验证**

Run: `pnpm db:generate -- --name export_jobs && DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/exports/create-export.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/db/schema src/exports src/app/api/exports drizzle
git commit -m "feat: create validated export snapshots"
```

---

### Task 2: 跨平台安全文件命名

**Files:**
- Create: `src/exports/file-name.ts`
- Create: `src/exports/file-name.test.ts`

**Interfaces:**
- Consumes: 日期、标准类型、开票方、号码、扩展名、副本序号。
- Produces: `buildInvoiceFileName(input): string`，UTF-8 最长 240 字节。

- [ ] **Step 1: 写非法字符、长度与副本测试**

```ts
test("replaces illegal characters and keeps required suffix", () => {
  expect(buildInvoiceFileName({ date: "2026-08-28", typeLabel: "增值税普通发票", sellerName: "北京/某:公司?", invoiceNumber: "123", extension: "PDF" }))
    .toBe("2026-08-28-增值税普通发票-北京 某 公司-123.pdf");
});

test("truncates only the seller and appends copy number", () => {
  const name = buildInvoiceFileName({ date: "2026-08-28", typeLabel: "铁路电子客票", sellerName: "很长".repeat(100), invoiceNumber: "123", extension: "pdf", copyNumber: 2 });
  expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(240);
  expect(name).toMatch(/-铁路电子客票-.*-123-副本2\.pdf$/);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/exports/file-name.test.ts`

Expected: FAIL，命名函数不存在。

- [ ] **Step 3: 实现确定性命名**

```ts
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

export function cleanSegment(value: string): string {
  return value.normalize("NFC").replace(ILLEGAL, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
}
```

Construct immutable prefix `date-type-`, suffix `-number[-副本N].ext`, then truncate seller by Unicode code point until total UTF-8 length is at most 240. Reject empty cleaned segments with stable error codes rather than inventing names.

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/exports/file-name.test.ts && pnpm typecheck`

Expected: PASS，非法字符、连续空格和尾部点号均按规则清理。

- [ ] **Step 5: 提交**

```bash
git add src/exports/file-name.ts src/exports/file-name.test.ts
git commit -m "feat: generate safe invoice file names"
```

---

### Task 3: 生成规范 Excel 明细

**Files:**
- Modify: `package.json`
- Create: `src/exports/excel.ts`
- Create: `src/exports/excel.test.ts`

**Interfaces:**
- Consumes: `AsyncIterable<ExportInvoiceRow>`。
- Produces: `writeInvoiceWorkbook(rows, output): Promise<void>`。

- [ ] **Step 1: 写工作簿结构测试**

```ts
test("writes dates and amounts as typed cells", async () => {
  const buffer = await workbookBuffer([fixtureExportRow]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("发票明细")!;
  expect(sheet.getCell("B2").value).toBeInstanceOf(Date);
  expect(sheet.getCell("I2").value).toBe(1280);
  expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  expect(sheet.autoFilter).toEqual("A1:M1");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/exports/excel.test.ts`

Expected: FAIL，Excel 模块不存在。

- [ ] **Step 3: 安装并实现流式 writer**

Run: `pnpm add exceljs`

Use `ExcelJS.stream.xlsx.WorkbookWriter`. Create one sheet `发票明细` with exactly 13 columns in the spec order. Set date format `yyyy-mm-dd`, money format `¥#,##0.00`, freeze first row, enable auto filter, commit each row immediately, and commit workbook after iteration. Convert validated decimal strings to numbers only at the final Excel cell boundary; totals continue to come from PostgreSQL numeric strings.

```ts
const EXPORT_COLUMNS = [
  { header: "发票类型", key: "type", width: 20 }, { header: "开票日期", key: "date", width: 14 },
  { header: "发票代码", key: "code", width: 20 }, { header: "发票号码", key: "number", width: 24 },
  { header: "开票方名称", key: "seller", width: 32 }, { header: "购买方名称", key: "buyer", width: 32 },
  { header: "不含税金额", key: "net", width: 16 }, { header: "税额", key: "tax", width: 14 },
  { header: "价税合计", key: "total", width: 16 }, { header: "报销状态", key: "status", width: 14 },
  { header: "原文件名", key: "original", width: 34 }, { header: "导出文件名", key: "exported", width: 48 },
  { header: "识别时间", key: "recognizedAt", width: 22 },
] as const;
const sheet = workbook.addWorksheet("发票明细", { views: [{ state: "frozen", ySplit: 1 }] });
sheet.columns = EXPORT_COLUMNS;
sheet.autoFilter = "A1:M1";
for await (const row of rows) {
  sheet.addRow(toExcelValues(row)).commit();
}
sheet.commit();
await workbook.commit();
```

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/exports/excel.test.ts && pnpm typecheck`

Expected: PASS，empty optional values become blank cells, not the strings `null` or `undefined`.

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml src/exports/excel.ts src/exports/excel.test.ts
git commit -m "feat: generate invoice Excel details"
```

---

### Task 4: 流式生成 ZIP 目录

**Files:**
- Modify: `package.json`
- Modify: `src/storage/object-store.ts`
- Modify: `src/storage/memory-object-store.ts`
- Modify: `src/storage/s3-object-store.ts`
- Modify: `src/storage/object-store.test.ts`
- Create: `src/exports/archive.ts`
- Create: `src/exports/archive.test.ts`

**Interfaces:**
- Consumes: 正式发票快照、Excel 流、`ObjectStore.getStream()`。
- Produces: `createExportArchive(input): Readable`；`ObjectStore.put` 接受 `Buffer | Readable`。

- [ ] **Step 1: 写目录与内容测试**

```ts
test("places workbook at root and invoices under month and type", async () => {
  const zip = await archiveBuffer([fixtureExportRow]);
  const entries = await unzipEntries(zip);
  expect(Object.keys(entries)).toEqual([
    "发票明细-2026-08.xlsx",
    "2026-08/增值税普通发票/2026-08-28-增值税普通发票-北京某某科技有限公司-123.pdf"
  ]);
  expect(entries[Object.keys(entries)[1]].toString()).toBe("original invoice");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/exports/archive.test.ts src/storage/object-store.test.ts`

Expected: FAIL，archive 不存在且存储接口不接收流。

- [ ] **Step 3: 安装依赖并实现流式管线**

Run: `pnpm add archiver @aws-sdk/lib-storage && pnpm add -D @types/archiver`

Update `ObjectStore.put` input body to `Buffer | Readable`; S3 uses `Upload` from `@aws-sdk/lib-storage`, memory adapter consumes streams only in tests. `createExportArchive` pipes Archiver into a `PassThrough`, appends workbook first, then awaits each `ObjectStore.getStream()` and appends with POSIX `/` paths. Listen for `warning` and `error`; abort output on any source error. Use compression level 6.

```ts
export function createExportArchive(input: ArchiveInput): Readable {
  const output = new PassThrough();
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (error) => output.destroy(error));
  archive.pipe(output);
  void appendEntries(archive, input).then(() => archive.finalize()).catch((error) => output.destroy(error));
  return output;
}
```

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/exports/archive.test.ts src/storage/object-store.test.ts && pnpm typecheck`

Expected: PASS；test asserts the archive source is a stream, not a full ZIP Buffer in production code.

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml src/storage src/exports/archive.ts src/exports/archive.test.ts
git commit -m "feat: stream organized invoice archives"
```

---

### Task 5: 异步导出、进度和限时下载

**Files:**
- Create: `src/jobs/generate-export.ts`
- Create: `src/jobs/generate-export.test.ts`
- Modify: `src/jobs/queues.ts`
- Modify: `src/worker.ts`
- Modify: `src/exports/create-export.ts`
- Create: `src/app/api/exports/[exportId]/route.ts`
- Create: `src/app/api/exports/[exportId]/download/route.ts`

**Interfaces:**
- Consumes: export job ID、快照项、archive、ObjectStore。
- Produces: queue `invoice-export`；`handleGenerateExport({ exportId })`；15 分钟下载 URL。

- [ ] **Step 1: 写幂等与下载所有权测试**

```ts
test("does not regenerate a ready export", async () => {
  const job = await seedExportJob({ userId: "u1", state: "ready" });
  await handleGenerateExport({ exportId: job.id });
  expect(objectStore.put).not.toHaveBeenCalled();
});

test("does not issue a URL to another user", async () => {
  const job = await seedExportJob({ userId: "u2", state: "ready" });
  await expect(getExportDownload({ userId: "u1", exportId: job.id })).rejects.toMatchObject({ code: "EXPORT_NOT_FOUND" });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/jobs/generate-export.test.ts`

Expected: FAIL，worker 不存在。

- [ ] **Step 3: 实现 worker 与 API**

Create queue with `retryLimit: 2`, `retryDelay: 10`, `retryBackoff: true`, `expireInSeconds: 1800`. Handler changes `queued -> generating`, builds exact workbook/archive from snapshot, stores at `users/{userId}/exports/{exportId}.zip`, then records size, `ready`, `completedAt`, `expiresAt = completedAt + 24h`. Failures store a stable code and actionable message; retries reuse the same object key. Download endpoint verifies owner and ready/not-expired state before requesting a signed URL with `900` seconds.

```ts
export async function handleGenerateExport({ exportId }: { exportId: string }) {
  const job = await lockExportJob(exportId);
  if (job.state === "ready" || job.state === "expired") return;
  await setExportState(exportId, "generating");
  const key = `users/${job.userId}/exports/${job.id}.zip`;
  const archive = createExportArchive(await buildArchiveInput(job.id));
  await objectStore.put({ key, body: archive, contentType: "application/zip" });
  await markExportReady({ exportId, key, expiresAt: new Date(Date.now() + 86_400_000) });
}
```

- [ ] **Step 4: 验证**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/jobs/generate-export.test.ts && pnpm typecheck`

Expected: PASS；stored ZIP path never includes user-controlled text.

- [ ] **Step 5: 提交**

```bash
git add src/jobs src/worker.ts src/exports/create-export.ts src/app/api/exports
git commit -m "feat: generate and download exports asynchronously"
```

---

### Task 6: 整理导出页面

**Files:**
- Create: `src/app/(workbench)/exports/page.tsx`
- Create: `src/components/exports/export-form.tsx`
- Create: `src/components/exports/export-form.test.tsx`
- Create: `src/components/exports/export-progress.tsx`
- Create: `src/components/exports/directory-preview.tsx`

**Interfaces:**
- Consumes: preview/create/status/download APIs。
- Produces: 范围选择、问题清单、目录预览、异步进度、Excel+ZIP 下载操作。

- [ ] **Step 1: 写预检阻止测试**

```tsx
test("does not create an export while preview has issues", async () => {
  const create = vi.fn();
  render(<ExportForm preview={previewWithMissingSeller} createExport={create} />);
  expect(screen.getByText("1 张发票需要补全开票方名称")).toBeVisible();
  expect(screen.getByRole("button", { name: "生成 Excel + ZIP" })).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/components/exports/export-form.test.tsx`

Expected: FAIL，导出表单不存在。

- [ ] **Step 3: 实现导出交互**

Filters include month/year, invoice type and reimbursement status. Preview shows count, exact total amount, estimated size, naming pattern and a sample directory. After creation, poll only `queued|generating`, show a progress state without fake percentages, and enable `下载 ZIP` only when ready. Expired jobs show `重新生成`; failed jobs show the stable user message and `按原范围重试`.

```tsx
const canSubmit = preview.canCreate && !isPending;
return <form onSubmit={submitExport}>
  <ExportFilters value={filters} onChange={setFilters} />
  <DirectoryPreview preview={preview} />
  <button type="submit" disabled={!canSubmit}>生成 Excel + ZIP</button>
  <div aria-live="polite">{statusMessage}</div>
</form>;
```

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/components/exports && pnpm lint && pnpm typecheck && pnpm build`

Expected: PASS；mobile layout keeps primary action visible without horizontal scrolling.

- [ ] **Step 5: 提交**

```bash
git add src/app/'(workbench)'/exports src/components/exports
git commit -m "feat: add export preparation and progress UI"
```

---

### Task 7: 24 小时清理、端到端闭环和发布检查

**Files:**
- Create: `src/jobs/cleanup-exports.ts`
- Create: `src/jobs/cleanup-exports.test.ts`
- Modify: `src/jobs/boss.ts`
- Create: `e2e/export.spec.ts`
- Create: `e2e/full-workflow.spec.ts`
- Create: `e2e/security.spec.ts`
- Create: `e2e/responsive.spec.ts`
- Create: `scripts/benchmark-ocr.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`
- Modify: `README.md`
- Create: `docs/operations.md`

**Interfaces:**
- Consumes: 过期 export jobs、ObjectStore。
- Produces: hourly queue `cleanup-expired-exports`；完整 MVP 回归套件与运维说明。

- [ ] **Step 1: 写清理容错测试**

```ts
test("marks a job expired only after its object is deleted", async () => {
  const job = await seedExportJob({ state: "ready", expiresAt: new Date("2026-08-30T00:00:00Z") });
  await cleanupExpiredExports(new Date("2026-08-31T00:00:00Z"));
  expect(objectStore.delete).toHaveBeenCalledWith(job.storageKey);
  expect(await getExportState(job.id)).toBe("expired");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/jobs/cleanup-exports.test.ts`

Expected: FAIL，清理任务不存在。

- [ ] **Step 3: 实现 hourly 清理和运维文档**

Run: `pnpm add -D tsx`

Register a pg-boss schedule `cleanup-expired-exports` with cron `0 * * * *`. Select at most 100 expired ready jobs per run, delete each object, then mark expired. On storage failure leave state ready-but-expired, expose no download URL, and retry next hour. `docs/operations.md` documents required env names, database migration, web/worker processes, health checks, backup scope, 24-hour export retention and credential rotation without values.

```ts
export async function cleanupExpiredExports(now = new Date()) {
  for (const job of await findExpiredReadyExports(now, 100)) {
    try { await objectStore.delete(job.storageKey); await markExportExpired(job.id); }
    catch (error) { await recordExportCleanupError(job.id, safeErrorCode(error)); }
  }
}
```

Add `private-fixtures/` to `.gitignore`. `scripts/benchmark-ocr.ts` reads `private-fixtures/ocr/manifest.json` with entries `{ file, expected: { type, invoiceDate, invoiceNumber, sellerName, totalAmount } }`, calls the configured provider sequentially, compares normalized core fields, prints per-field and overall exact-match rates, and exits non-zero when any core field is below 95%. It must print fixture IDs only, never OCR text or credentials.

- [ ] **Step 4: 写完整端到端用例**

```ts
test("completes upload to ZIP workflow", async ({ page }) => {
  await loginAsTestUser(page);
  await uploadFixture(page, "e2e/fixtures/invoice.pdf");
  await confirmRecognizedDraft(page);
  await page.goto("/invoices?month=2026-08");
  await setSelectedStatus(page, "in_progress");
  await page.goto("/exports?month=2026-08");
  await page.getByRole("button", { name: "生成 Excel + ZIP" }).click();
  await expect(page.getByRole("link", { name: "下载 ZIP" })).toBeVisible();
});
```

Run: `pnpm playwright test e2e/export.spec.ts e2e/full-workflow.spec.ts --project=chromium --project=webkit`

Expected: desktop Chromium、WebKit 与移动项目全部 PASS。

`e2e/security.spec.ts` signs in two users and asserts user B receives 404 for user A's invoice, draft, export status and download endpoints. `e2e/responsive.spec.ts` runs the upload, review, list and export pages at 390×844, 768×1024 and 1440×900, asserting no document-level horizontal overflow and all primary actions are reachable. Seed 500 invoices in the test database and assert the list and dashboard API responses complete within 2 seconds on the CI runner.

With the agreed private invoice sample set present, run: `OCR_DRIVER=tencent pnpm tsx scripts/benchmark-ocr.ts`

Expected: each core field exact-match rate is at least 95%; sample files remain untracked.

- [ ] **Step 5: 最终验证与提交**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm playwright test && pnpm build`

Expected: 全部 PASS；测试日志不含 OCR 凭证、对象签名或完整 OCR 原文。

```bash
git add src e2e scripts/benchmark-ocr.ts package.json pnpm-lock.yaml .gitignore README.md docs/operations.md
git commit -m "feat: complete invoice workbench MVP"
```

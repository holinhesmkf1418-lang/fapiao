# 发票上传识别与校对 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付批量上传、文件查重、异步 OCR、业务查重与人工校对入库闭环。

**Architecture:** 浏览器先创建导入批次，再以单文件请求并发上传，服务端流转为私有对象、计算 SHA-256 并创建 pg-boss 任务。OCR 供应商响应先进入 `OcrProvider` 适配层和草稿表，用户确认后才写入正式发票表。

**Tech Stack:** Next.js Route Handlers、PostgreSQL 16、Drizzle ORM、pg-boss、腾讯云 OCR Node SDK、Zod、Web Crypto、Vitest、Testing Library、Playwright

**Spec:** `docs/product-design.md`

## Global Constraints

- 单批最多 100 个文件，单文件最大 20 MB。
- 支持扩展名 PDF、OFD、JPG、JPEG、PNG；服务端同时校验 MIME 与文件头。
- 每个文件独立成功或失败，一个失败项不得中止整批。
- 文件内容指纹查重在调用收费 OCR 前完成。
- 真实 OCR 凭证只从环境变量读取，响应与日志不得包含完整票面原文。
- 关键字段为日期、类型、开票方、价税合计、发票号码或唯一凭证号；未确认前不能正式入库。
- 金额使用两位小数字符串，经 Decimal 解析后写入 PostgreSQL `numeric(14,2)`。

---

### Task 1: 建立导入、草稿与发票数据模型

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/domain/invoice.ts`
- Create: `src/domain/invoice.test.ts`
- Create: `src/db/schema/invoices.ts`
- Modify: `src/db/schema/index.ts`
- Create: `src/test/db.ts`
- Create: `src/test/factories/invoice.ts`
- Create: `drizzle/0001_invoice_ingestion.sql` (generated)

**Interfaces:**
- Consumes: `users.id`。
- Produces: `InvoiceStatus`、`InvoiceType`、`ImportItemState`；表 `import_batches`、`import_items`、`invoice_drafts`、`invoices`、`duplicate_matches`。

- [ ] **Step 1: 写金额与类型标准化失败测试**

```ts
import { normalizeAmount, normalizeInvoiceType } from "./invoice";

test.each([["￥1,234.5", "1234.50"], ["123.00元", "123.00"]])("normalizes amount", (input, output) => {
  expect(normalizeAmount(input)).toBe(output);
});

test("maps a digital normal invoice", () => {
  expect(normalizeInvoiceType("电子发票（普通发票）")).toBe("digital_normal");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/domain/invoice.test.ts`

Expected: FAIL，领域模块不存在。

- [ ] **Step 3: 定义领域类型与表**

Run: `pnpm add decimal.js`

```ts
export const invoiceTypes = ["vat_normal", "vat_special", "digital_normal", "digital_special", "railway", "taxi", "flight_itinerary", "other"] as const;
export type InvoiceType = (typeof invoiceTypes)[number];
export const invoiceStatuses = ["pending", "in_progress", "reimbursed"] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];
export const importItemStates = ["uploading", "stored", "duplicate_blocked", "queued", "recognizing", "review", "confirmed", "failed"] as const;
export type ImportItemState = (typeof importItemStates)[number];

export function normalizeAmount(input: string): string {
  const cleaned = input.replace(/[￥¥元,\s]/g, "");
  return new Decimal(cleaned).toFixed(2);
}
```

The Drizzle schema must use UUID primary keys and include:

```ts
export const invoices = pgTable("invoice", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sourceItemId: uuid("source_item_id").notNull(),
  type: invoiceTypeEnum("type").notNull(),
  invoiceDate: date("invoice_date").notNull(),
  invoiceCode: text("invoice_code"),
  invoiceNumber: text("invoice_number").notNull(),
  sellerName: text("seller_name").notNull(),
  buyerName: text("buyer_name"),
  amountWithoutTax: numeric("amount_without_tax", { precision: 14, scale: 2 }),
  taxAmount: numeric("tax_amount", { precision: 14, scale: 2 }),
  totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),
  status: invoiceStatusEnum("status").default("pending").notNull(),
  storageKey: text("storage_key").notNull(),
  originalFileName: text("original_file_name").notNull(),
  contentType: text("content_type").notNull(),
  sha256: char("sha256", { length: 64 }).notNull(),
  recognizedAt: timestamp("recognized_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

`import_items` stores user ownership through batch, object key, file metadata, SHA-256, state, error code/message and timestamps. `invoice_drafts` stores normalized nullable fields, per-field confidence JSON, provider request ID and sanitized raw summary JSON. `duplicate_matches` stores candidate invoice ID, reasons array, score, resolution and force-keep reason.

`src/test/db.ts` exports `resetDatabase()` and skips with a clear message when `DATABASE_URL_TEST` is absent. `src/test/factories/invoice.ts` exports these exact helpers for later tasks:

```ts
export function seedUser(input: { id: string; email?: string }): Promise<User>;
export function seedInvoice(input: Partial<NewInvoice> & { userId: string }): Promise<Invoice>;
export function seedStoredItem(input?: Partial<NewImportItem>): Promise<ImportItem>;
export function getItemState(id: string): Promise<ImportItemState>;
export function countDrafts(importItemId: string): Promise<number>;
export function getStatus(invoiceId: string): Promise<InvoiceStatus>;
export function findInvoice(invoiceId: string): Promise<Invoice | null>;
```

- [ ] **Step 4: 生成 migration 并验证**

Run: `pnpm db:generate -- --name invoice_ingestion && pnpm test -- src/domain/invoice.test.ts && pnpm typecheck`

Expected: migration 含用户与 SHA-256 查询索引、代码号码组合索引；测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml src/domain src/db/schema src/test drizzle
git commit -m "feat: add invoice ingestion schema"
```

---

### Task 2: 创建批次并逐文件上传

**Files:**
- Create: `src/imports/validation.ts`
- Create: `src/imports/service.ts`
- Create: `src/imports/service.test.ts`
- Create: `src/app/api/imports/route.ts`
- Create: `src/app/api/imports/[batchId]/files/route.ts`

**Interfaces:**
- Consumes: `requireSession()`、`ObjectStore.put()`、导入表。
- Produces: `createImportBatch(userId, count)`；`storeImportFile({ userId, batchId, file }) -> ImportItemResult`。

- [ ] **Step 1: 写文件校验测试**

```ts
test("rejects a disguised executable", async () => {
  const file = new File([Buffer.from("MZ")], "fake.pdf", { type: "application/pdf" });
  await expect(validateInvoiceFile(file)).rejects.toMatchObject({ code: "INVALID_FILE_SIGNATURE" });
});

test("rejects the 101st item before storage", async () => {
  await expect(createImportBatch("u1", 101)).rejects.toMatchObject({ code: "BATCH_LIMIT_EXCEEDED" });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/imports/service.test.ts`

Expected: FAIL，服务不存在。

- [ ] **Step 3: 实现校验、哈希和存储**

```ts
export type ImportItemResult = {
  itemId: string;
  state: "stored" | "duplicate_blocked";
  sha256: string;
  duplicateInvoiceId?: string;
};

export async function sha256(buffer: Buffer): Promise<string> {
  return createHash("sha256").update(buffer).digest("hex");
}
```

Validate size `>0 && <=20*1024*1024`, allowed extension, MIME, and magic bytes (`%PDF` for PDF, ZIP container inspection for OFD, JPEG `ffd8ff`, PNG `89504e47`). Sanitize the original name for display but never use it as the object key. Store as `users/{userId}/imports/{batchId}/{itemId}.{ext}`.

The file route accepts one multipart field named `file`; Task 8 limits browser concurrency to three without changing this one-file transaction boundary. The server obtains `userId` only from `requireSession()` and verifies batch ownership before storage.

Before creating a batch, count that user's batches created in the last minute and active items in `uploading|stored|queued|recognizing|review`. Reject with `RATE_LIMITED` when there are already 10 batches in the last minute or 100 active items; include a retry-after value and do not create partial rows.

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/imports/service.test.ts && pnpm typecheck`

Expected: valid fixtures are stored; invalid files never call `ObjectStore.put()`。

- [ ] **Step 5: 提交**

```bash
git add src/imports src/app/api/imports
git commit -m "feat: add validated batch uploads"
```

---

### Task 3: 在 OCR 前阻止完全重复文件

**Files:**
- Create: `src/imports/duplicate-file.ts`
- Create: `src/imports/duplicate-file.test.ts`
- Modify: `src/imports/service.ts`

**Interfaces:**
- Consumes: `userId`、SHA-256、正式发票表与未完成导入项。
- Produces: `findFileDuplicate(userId, sha256): Promise<{ invoiceId?: string; importItemId?: string } | null>`。

- [ ] **Step 1: 写所有权隔离测试**

```ts
test("does not treat another user's hash as a duplicate", async () => {
  await seedInvoice({ userId: "u2", sha256: HASH });
  expect(await findFileDuplicate("u1", HASH)).toBeNull();
});

test("returns the current user's original invoice", async () => {
  const invoice = await seedInvoice({ userId: "u1", sha256: HASH });
  expect(await findFileDuplicate("u1", HASH)).toEqual({ invoiceId: invoice.id });
});
```

- [ ] **Step 2: 运行数据库集成测试验证失败**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/imports/duplicate-file.test.ts`

Expected: FAIL，查询函数不存在。

- [ ] **Step 3: 实现查重事务**

Query current user's confirmed invoices first, then active import items in states `stored|queued|recognizing|review`. When found, mark the new item `duplicate_blocked`, save a reason `same_sha256`, delete the newly stored redundant object, and do not enqueue OCR.

```ts
export async function findFileDuplicate(userId: string, sha256: string) {
  const [invoice] = await db.select({ invoiceId: invoices.id }).from(invoices)
    .where(and(eq(invoices.userId, userId), eq(invoices.sha256, sha256))).limit(1);
  if (invoice) return invoice;
  const [item] = await db.select({ importItemId: importItems.id }).from(importItems)
    .innerJoin(importBatches, eq(importItems.batchId, importBatches.id))
    .where(and(eq(importBatches.userId, userId), eq(importItems.sha256, sha256), inArray(importItems.state, ["stored", "queued", "recognizing", "review"]))).limit(1);
  return item ?? null;
}
```

- [ ] **Step 4: 验证**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/imports/duplicate-file.test.ts`

Expected: PASS；断言队列发送函数未调用。

- [ ] **Step 5: 提交**

```bash
git add src/imports
git commit -m "feat: block duplicate invoice files"
```

---

### Task 4: 定义 OCR 合约与固定响应实现

**Files:**
- Create: `src/ocr/types.ts`
- Create: `src/ocr/provider.ts`
- Create: `src/ocr/fake-provider.ts`
- Create: `src/ocr/fake-provider.test.ts`
- Create: `src/ocr/index.ts`

**Interfaces:**
- Consumes: 私有对象的短期下载 URL。
- Produces: `OcrProvider.recognize(input): Promise<OcrResponse>`，供应商无关的标准草稿数组。

- [ ] **Step 1: 写合约测试**

```ts
test("fake provider returns normalized drafts without vendor fields", async () => {
  const provider = new FakeOcrProvider([fixtureDraft]);
  const result = await provider.recognize({ fileUrl: "https://signed.test/a.pdf", fileType: "pdf" });
  expect(result.drafts[0]).toMatchObject({ type: "vat_normal", totalAmount: "128.00" });
  expect(JSON.stringify(result)).not.toContain("VatInvoiceInfos");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/ocr/fake-provider.test.ts`

Expected: FAIL，OCR 类型不存在。

- [ ] **Step 3: 实现稳定接口**

```ts
export type RecognizedInvoiceDraft = {
  type: InvoiceType | null;
  invoiceDate: string | null;
  invoiceCode: string | null;
  invoiceNumber: string | null;
  sellerName: string | null;
  buyerName: string | null;
  amountWithoutTax: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  confidence: Partial<Record<"type" | "invoiceDate" | "invoiceCode" | "invoiceNumber" | "sellerName" | "buyerName" | "amountWithoutTax" | "taxAmount" | "totalAmount", number>>;
};

export interface OcrProvider {
  recognize(input: { fileUrl: string; fileType: "pdf" | "ofd" | "jpg" | "jpeg" | "png" }): Promise<{ requestId: string; drafts: RecognizedInvoiceDraft[]; sanitizedSummary: Record<string, unknown> }>;
}
```

`getOcrProvider()` selects `fake` or `tencent` from validated environment only.

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/ocr/fake-provider.test.ts && pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ocr
git commit -m "feat: define vendor neutral OCR contract"
```

---

### Task 5: 腾讯云通用票据识别适配器

**Files:**
- Create: `src/ocr/tencent-provider.ts`
- Create: `src/ocr/tencent-mapper.ts`
- Create: `src/ocr/tencent-mapper.test.ts`
- Create: `src/ocr/fixtures/tencent-general-invoice.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: 腾讯云 `RecognizeGeneralInvoice`、短期签名 URL。
- Produces: 符合 `OcrProvider` 的 `TencentOcrProvider`；纯函数 `mapTencentResponse(response): OcrResponse`。

- [ ] **Step 1: 保存脱敏 fixture 并写映射测试**

```ts
test("maps Tencent fields into the invoice draft", () => {
  const result = mapTencentResponse(fixture);
  expect(result.drafts).toEqual([expect.objectContaining({
    type: "digital_normal", invoiceDate: "2026-08-28", invoiceNumber: "25112000000018475031",
    sellerName: "北京某某科技有限公司", totalAmount: "1280.00"
  })]);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/ocr/tencent-mapper.test.ts`

Expected: FAIL，映射器不存在。

- [ ] **Step 3: 安装 SDK 并实现适配器**

Run: `pnpm add tencentcloud-sdk-nodejs-ocr`

```ts
const response = await client.RecognizeGeneralInvoice({
  ImageUrl: input.fileUrl,
  EnableMultiplePage: input.fileType === "pdf",
  EnablePdf: input.fileType === "pdf",
});
return mapTencentResponse(response);
```

Map each Tencent invoice kind explicitly to `InvoiceType`; unknown kinds become `other`. Normalize currency and date through domain functions. `sanitizedSummary` may contain kind names, field-presence booleans and page counts, but not complete OCR text. Preserve `RequestId` for support diagnostics.

- [ ] **Step 4: 验证映射与类型**

Run: `pnpm test -- src/ocr/tencent-mapper.test.ts && pnpm typecheck`

Expected: PASS；测试不调用真实腾讯云。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml src/ocr
git commit -m "feat: integrate Tencent invoice OCR adapter"
```

---

### Task 6: pg-boss 识别队列与重试

**Files:**
- Create: `src/jobs/boss.ts`
- Create: `src/jobs/queues.ts`
- Create: `src/jobs/recognize-invoice.ts`
- Create: `src/jobs/recognize-invoice.test.ts`
- Create: `src/worker.ts`
- Modify: `src/imports/service.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `importItemId`、ObjectStore、OcrProvider。
- Produces: queue `invoice-recognize`；`handleRecognizeInvoice({ importItemId })`。

- [ ] **Step 1: 写 worker 状态测试**

```ts
test("moves an item from queued to review", async () => {
  const item = await seedStoredItem();
  fakeProvider.setDrafts([fixtureDraft]);
  await handleRecognizeInvoice({ importItemId: item.id });
  expect(await getItemState(item.id)).toBe("review");
  expect(await countDrafts(item.id)).toBe(1);
});
```

- [ ] **Step 2: 运行集成测试验证失败**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/jobs/recognize-invoice.test.ts`

Expected: FAIL，handler 不存在。

- [ ] **Step 3: 实现幂等 worker**

Install `pg-boss`, add scripts `worker:dev` and `worker`. Create queue with `retryLimit: 3`, `retryDelay: 5`, `retryBackoff: true`, `expireInSeconds: 300`, and group concurrency `2` keyed by user ID. Handler locks the import item, returns without duplication if state is already `review|confirmed|duplicate_blocked`, updates to `recognizing`, creates a 180-second object URL, invokes OCR, replaces drafts in one transaction, and updates to `review`. On terminal failure, store stable error code and a user-action message without secrets.

```ts
export async function handleRecognizeInvoice({ importItemId }: { importItemId: string }) {
  const item = await lockImportItem(importItemId);
  if (["review", "confirmed", "duplicate_blocked"].includes(item.state)) return;
  await setImportItemState(item.id, "recognizing");
  const fileUrl = await objectStore.signedDownloadUrl(item.storageKey, 180);
  const response = await ocrProvider.recognize({ fileUrl, fileType: item.extension });
  await replaceDraftsAndState({ item, response, nextState: "review" });
}
```

- [ ] **Step 4: 验证重试与幂等性**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/jobs/recognize-invoice.test.ts`

Expected: PASS；重复执行 handler 不会创建第二组草稿。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml src/jobs src/worker.ts src/imports/service.ts
git commit -m "feat: process OCR jobs asynchronously"
```

---

### Task 7: 业务重复检测与确认入库

**Files:**
- Create: `src/invoices/duplicate-business.ts`
- Create: `src/invoices/confirm-draft.ts`
- Create: `src/invoices/confirm-draft.test.ts`
- Create: `src/app/api/drafts/[draftId]/confirm/route.ts`

**Interfaces:**
- Consumes: 草稿、当前用户正式发票。
- Produces: `findBusinessDuplicates(userId, draft)`；`confirmDraft(input) -> { invoiceId } | DuplicateBlocked`。

- [ ] **Step 1: 写精确与疑似重复测试**

```ts
test("blocks matching code and number", async () => {
  await seedInvoice({ userId: "u1", invoiceCode: "1100", invoiceNumber: "1234" });
  await expect(confirmDraft({ userId: "u1", draftId, values })).rejects.toMatchObject({ code: "DUPLICATE_BLOCKED" });
});

test("allows force keep with a reason", async () => {
  const result = await confirmDraft({ userId: "u1", draftId, values, forceKeep: { reason: "同号但属于不同电子客票" } });
  expect(result.invoiceId).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/invoices/confirm-draft.test.ts`

Expected: FAIL，确认服务不存在。

- [ ] **Step 3: 实现规则和事务**

Exact duplicate: same normalized `invoiceCode + invoiceNumber`; when code is absent, same `invoiceNumber + type`. Suspected duplicate: same date, exact cent amount, normalized seller name, and same type. Return reasons and candidate summary. Validate all required fields with Zod, verify draft ownership, create formal invoice with status `pending`, mark draft/item confirmed, and record force-keep reason in one transaction.

```ts
const confirmDraftInput = z.object({
  draftId: z.string().uuid(), type: z.enum(invoiceTypes), invoiceDate: z.iso.date(),
  invoiceCode: z.string().trim().nullable(), invoiceNumber: z.string().trim().min(1),
  sellerName: z.string().trim().min(1), buyerName: z.string().trim().nullable(),
  amountWithoutTax: moneyString.nullable(), taxAmount: moneyString.nullable(), totalAmount: moneyString,
  forceKeep: z.object({ reason: z.string().trim().min(5).max(200) }).optional(),
});
```

- [ ] **Step 4: 验证**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/invoices/confirm-draft.test.ts`

Expected: PASS；跨用户相同号码不构成重复。

- [ ] **Step 5: 提交**

```bash
git add src/invoices src/app/api/drafts
git commit -m "feat: confirm reviewed invoices with duplicate guard"
```

---

### Task 8: 上传进度、校对页与阶段端到端测试

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/app/(workbench)/upload/page.tsx`
- Create: `src/components/upload/invoice-uploader.tsx`
- Create: `src/components/upload/invoice-uploader.test.tsx`
- Create: `src/app/(workbench)/imports/[batchId]/page.tsx`
- Create: `src/components/review/invoice-review-form.tsx`
- Create: `src/components/review/invoice-review-form.test.tsx`
- Create: `src/app/api/imports/items/[itemId]/manual-draft/route.ts`
- Create: `playwright.config.ts`
- Create: `e2e/helpers.ts`
- Create: `e2e/ingestion.spec.ts`

**Interfaces:**
- Consumes: import APIs、draft confirm API。
- Produces: 最大并发 3 的逐文件上传 UI、状态轮询、低置信度标黄、重复阻止对话框。

- [ ] **Step 1: 写上传队列组件测试**

```tsx
test("keeps successful files when one upload fails", async () => {
  render(<InvoiceUploader upload={fakeUpload({ "bad.pdf": "NETWORK_ERROR" })} />);
  await selectFiles([goodPdf, badPdf]);
  expect(await screen.findByText("good.pdf · 已上传")).toBeVisible();
  expect(await screen.findByRole("button", { name: "重试 bad.pdf" })).toBeVisible();
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/components/upload src/components/review`

Expected: FAIL，页面组件不存在。

- [ ] **Step 3: 实现上传和校对交互**

Run: `pnpm add -D @playwright/test && pnpm exec playwright install chromium webkit`

Use `accept=".pdf,.ofd,.jpg,.jpeg,.png"`, show per-file states, preserve the batch after refresh, and poll only while items are non-terminal. Review form fields must expose confidence through text and color; required low-confidence fields show `需要确认`. Duplicate dialog shows reason, original invoice summary, `返回修改`, and a separate `仍然保留` action requiring a reason.

```ts
async function uploadWithConcurrency(files: File[], upload: (file: File) => Promise<void>) {
  const queue = [...files];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) { const file = queue.shift(); if (file) await upload(file).catch(() => undefined); }
  }));
}
```

For an item in terminal `failed` state, show `重试识别` and `人工录入`. The manual-draft route verifies ownership and failed state, creates one empty draft linked to the original file, changes the item to `review`, and never fabricates confidence values. The same required-field validation applies before confirmation.

`e2e/helpers.ts` exports `loginAsTestUser(page)`, which creates or reuses `e2e@example.com` through a test-only seed endpoint enabled only when `NODE_ENV=test`, then signs in through the UI. It also exports `uploadFixture(page, path)` and `confirmRecognizedDraft(page)`. Production builds must return 404 from the seed endpoint.

- [ ] **Step 4: 写并运行端到端用例**

```ts
test("uploads, reviews and confirms an invoice", async ({ page }) => {
  await loginAsTestUser(page);
  await page.goto("/upload");
  await page.getByLabel("选择发票文件").setInputFiles("e2e/fixtures/invoice.pdf");
  await expect(page.getByText("等待校对")).toBeVisible();
  await page.getByLabel("开票方名称").fill("北京某某科技有限公司");
  await page.getByRole("button", { name: "确认入库" }).click();
  await expect(page.getByText("已入库")).toBeVisible();
});
```

Run: `pnpm playwright test e2e/ingestion.spec.ts --project=chromium`

Expected: PASS with `OCR_DRIVER=fake` and `OBJECT_STORE_DRIVER=memory`。

- [ ] **Step 5: 全量验证并提交**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm playwright test e2e/ingestion.spec.ts --project=chromium && pnpm build`

Expected: 全部 PASS。

```bash
git add src/app src/components playwright.config.ts e2e package.json pnpm-lock.yaml
git commit -m "feat: complete invoice ingestion workflow"
```

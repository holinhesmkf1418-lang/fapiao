# 本地发票上传识别与校对 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 PDF、OFD、JPG、JPEG、PNG 的本地优先识别、查重、人工校对与手动云端兜底闭环。

**Architecture:** 浏览器逐文件上传，本地服务完成文件头校验、临时写入、SHA-256 和任务入队。Swift CLI 使用 PDFKit/Vision 离线提取文字，TypeScript 负责 OFD XML、字段标准化和置信度；腾讯云 `RecognizeGeneralInvoice` 仅在单张发票二次确认后调用。

**Tech Stack:** Next.js Route Handlers、SQLite/Drizzle、Swift 6、Vision、PDFKit、Security.framework、fast-xml-parser、unzipper、Zod、腾讯云 OCR Node SDK、Vitest、Playwright

**Spec:** `docs/product-design.md`

## Global Constraints

- 单批最多 100 个文件，单文件最大 20 MB；支持 PDF、OFD、JPG、JPEG、PNG。
- 每个文件独立处理；单个失败不得中断整批。
- 本地顺序固定为 PDF 文字层 → Apple Vision → OFD 本地解析/图像 OCR → 字段解析。
- 本地识别任务不得发起网络请求。
- 未点击并二次确认“使用云端重新识别”时，不得上传发票。
- 完全重复文件和相同代码/号码默认阻止入库；强制保留必须填写原因。
- 关键字段未确认前只能是草稿；确认入库后的初始状态为“待报销”。
- 每个 Task 完成后独立提交并运行 `git push origin HEAD`。

---

## File Structure

```text
native/InvoiceNative/                 # SwiftPM 本地 OCR 与钥匙串 CLI
src/lib/imports/                      # 上传校验、文件落盘、批次状态
src/lib/recognition/                  # 本地识别编排、字段解析、置信度
src/lib/ofd/                          # OFD ZIP/XML 与内嵌图像解析
src/lib/duplicates/                   # 文件级和业务级重复判断
src/lib/cloud-ocr/                    # 明确触发的可替换云端适配层
src/app/api/imports/                  # 上传、状态与确认 API
src/app/api/cloud-ocr/                # 凭证设置和单张云端重识别 API
src/app/upload/                       # 上传与校对页面
tests/fixtures/invoices/              # 人工生成、无真实个人信息的测试票据
```

## Shared Interfaces

```ts
export type SupportedFormat = "pdf" | "ofd" | "png" | "jpeg";
export type FileProbe = { name: string; size: number; mime: string; firstBytes: Uint8Array };
export type ValidatedFile = { originalName: string; size: number; format: SupportedFormat; extension: string };
export type StoredSource = { id: string; originalName: string; managedRelativePath: string; format: SupportedFormat; size: number; sha256: string };
export type RecognitionPage = { index: number; lines: Array<{ text: string; confidence: number }> };
export type RecognitionDocument = { engine: "pdf-text" | "vision" | "ofd-text" | "ofd-image"; pages: RecognitionPage[]; warnings: string[] };
export type NativeRecognitionInput = { kind: "image" | "pdf"; path: string };
export type NativeDocument = { source: "pdf-text" | "vision-image" | "vision-pdf"; pages: RecognitionPage[] };
export type OfdDocument = { pages: Array<{ index: number; text: string; imagePaths: string[] }>; warnings: string[] };
export type InvoiceFields = {
  invoiceType: string | null; issueDate: string | null; invoiceCode: string | null;
  invoiceNumber: string | null; uniqueVoucherNumber: string | null; sellerName: string | null;
  buyerName: string | null; amountExcludingTaxCents: number | null; taxCents: number | null;
  totalAmountCents: number | null;
};
export type InvoiceFieldKey = keyof InvoiceFields;
export type ParsedInvoiceDraft = { fields: InvoiceFields; confidence: Record<InvoiceFieldKey, number>; warnings: string[] };
export type DuplicateCandidate = { invoiceId: string; reason: "code_number" | "number_date_amount_type_seller"; evidence: string[] };
export type ConfirmDraftInput = { draftId: string; edits: InvoiceFields; forceKeepReason?: string };
export type ConfirmedInvoice = InvoiceFields & { id: string; reimbursementStatus: "pending"; sourceFileId: string };
export type CloudRecognitionInput = { bytes: Buffer; format: SupportedFormat };
export type CloudRecognitionResult = { requestId: string; draft: ParsedInvoiceDraft };
export interface CloudOcrProvider { recognize(input: CloudRecognitionInput): Promise<CloudRecognitionResult> }
```

`WorkPaths` and `LocalJobQueue` are imported from the completed foundation plan at `src/lib/bootstrap/types.ts` and `src/lib/jobs/queue.ts`.

### Task 1: Swift 本地识别与钥匙串助手

**Files:**
- Create: `native/InvoiceNative/Package.swift`
- Create: `native/InvoiceNative/Sources/InvoiceNative/main.swift`
- Create: `native/InvoiceNative/Sources/InvoiceNative/Recognition.swift`
- Create: `native/InvoiceNative/Sources/InvoiceNative/Keychain.swift`
- Create: `native/InvoiceNative/Tests/InvoiceNativeTests/RecognitionTests.swift`
- Create: `src/lib/native/client.ts`
- Test: `tests/lib/native/client.test.ts`
- Modify: `package.json`, `scripts/install.mjs`

**Interfaces:**
- Produces stdin JSONL commands `recognizeImage`, `extractPdf`, `recognizePdf`, `keychainSet`, `keychainGet`, `keychainDelete`
- Produces stdout `NativeResponse = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }`
- Produces `nativeRecognize(input: NativeRecognitionInput): Promise<NativeDocument>`
- Produces keychain service `cn.local.invoice-workbench.tencent-ocr`

- [ ] **Step 1: Write failing Swift and TypeScript contract tests**

```swift
func testNormalizeVisionResultKeepsConfidence() {
  let result = normalize([VisionLine(text: "价税合计 ¥128.00", confidence: 0.93)])
  XCTAssertEqual(result.lines[0].text, "价税合计 ¥128.00")
  XCTAssertEqual(result.lines[0].confidence, 0.93, accuracy: 0.001)
}
```

```ts
it("maps a native JSONL response without exposing stderr", async () => {
  const doc = await nativeRecognize({ kind: "image", path: fixture("invoice.png") }, fakeRunner);
  expect(doc.pages[0].lines[0]).toEqual({ text: "发票号码 12345678", confidence: 0.96 });
});
```

- [ ] **Step 2: Run both test suites and verify failure**

Run: `swift test --package-path native/InvoiceNative && pnpm vitest run tests/lib/native/client.test.ts`

Expected: FAIL because the package and client do not exist.

- [ ] **Step 3: Implement PDFKit/Vision and Security.framework commands**

Use `PDFDocument.string` first; if meaningful text is absent, render each PDF page at 2× scale and run `VNRecognizeTextRequest` with recognition level `.accurate` and languages `zh-Hans`, `zh-Hant`, `en-US`. Read every command from stdin and emit exactly one JSON response. Keychain commands use `SecItemAdd`, `SecItemCopyMatching`, and `SecItemDelete`; secrets enter through stdin and never through command arguments or stderr.

```ts
export type NativeDocument = {
  source: "pdf-text" | "vision-image" | "vision-pdf";
  pages: Array<{ index: number; lines: Array<{ text: string; confidence: number }> }>;
};
```

- [ ] **Step 4: Verify the native binary and Node adapter**

Run: `swift test --package-path native/InvoiceNative && swift build -c release --package-path native/InvoiceNative && pnpm vitest run tests/lib/native && pnpm typecheck`

Expected: PASS; `strings`/process assertions show no supplied test secret in arguments or logs.

- [ ] **Step 5: Commit and push the native helper**

```bash
git add native src/lib/native tests/lib/native package.json pnpm-lock.yaml scripts/install.mjs
git commit -m "feat: add macos vision recognition helper"
git push origin HEAD
```

### Task 2: 文件校验、落盘与完全重复拦截

**Files:**
- Create: `src/lib/imports/types.ts`, `src/lib/imports/validate-file.ts`, `src/lib/imports/store-file.ts`
- Create: `src/lib/imports/repository.ts`
- Create: `src/app/api/imports/files/route.ts`
- Test: `tests/lib/imports/validate-file.test.ts`, `tests/lib/imports/store-file.test.ts`
- Test: `tests/app/api/import-files.test.ts`
- Create: `tests/fixtures/invoices/minimal.pdf`, `minimal.png`, `minimal.jpg`, `minimal.ofd`

**Interfaces:**
- Produces: `validateInvoiceFile(input: FileProbe): ValidatedFile`
- Produces: `storeSourceFile(input: ReadableStream, meta: ValidatedFile, paths: WorkPaths): Promise<StoredSource>`
- Produces: `POST /api/imports/files` with one multipart field `file`
- Produces response `201 { sourceFileId, status: "queued" }`, `409 { code: "DUPLICATE_FILE", existingId }`, or typed 4xx

- [ ] **Step 1: Write failing magic-byte and duplicate tests**

```ts
it.each([
  ["invoice.pdf", "%PDF-", "pdf"],
  ["invoice.png", "89504e470d0a1a0a", "png"],
  ["invoice.jpg", "ffd8ff", "jpeg"]
])("accepts %s only when extension and signature agree", (_, signature, format) => {
  expect(validateInvoiceFile(probe({ name: _, signature }))).toMatchObject({ format });
});

it("rejects the same sha256 before a second managed copy is committed", async () => {
  const first = await storeFixture("minimal.pdf");
  await expect(storeFixture("minimal.pdf")).rejects.toMatchObject({ code: "DUPLICATE_FILE", existingId: first.id });
});
```

- [ ] **Step 2: Run focused import tests**

Run: `pnpm vitest run tests/lib/imports tests/app/api/import-files.test.ts`

Expected: FAIL because validation and storage modules are missing.

- [ ] **Step 3: Implement bounded streaming and atomic file commit**

Compare declared size with free disk space before accepting the stream, requiring file size plus 50 MiB safety space. Reject after 20 MiB while streaming to `invoices/.tmp/<uuid>`, compute SHA-256 during the same pass, fsync, insert the source row, then rename to `invoices/YYYY-MM/<uuid>.<ext>`. For OFD require ZIP magic plus an `OFD.xml` entry. On any error close/unlink the temp file; never modify the browser-selected original.

- [ ] **Step 4: Verify valid, invalid, oversized, and duplicate cases**

Run: `pnpm vitest run tests/lib/imports tests/app/api/import-files.test.ts && pnpm typecheck`

Expected: PASS; the oversized fixture leaves no `.tmp` file and the duplicate response contains the original internal ID.

- [ ] **Step 5: Commit and push file ingestion**

```bash
git add src/lib/imports src/app/api/imports tests/lib/imports tests/app/api/import-files.test.ts tests/fixtures/invoices
git commit -m "feat: validate and store local invoice files"
git push origin HEAD
```

### Task 3: OFD 本地解析与统一文字文档

**Files:**
- Create: `src/lib/ofd/types.ts`, `src/lib/ofd/parse-ofd.ts`, `src/lib/ofd/extract-images.ts`
- Create: `src/lib/recognition/document.ts`, `src/lib/recognition/local-recognizer.ts`
- Test: `tests/lib/ofd/parse-ofd.test.ts`, `tests/lib/recognition/local-recognizer.test.ts`
- Create: `tests/fixtures/invoices/text.ofd`, `image-page.ofd`

**Interfaces:**
- Produces: `parseOfd(path: string): Promise<OfdDocument>`
- Produces: `recognizeLocal(source: StoredSource): Promise<RecognitionDocument>`
- Produces: `RecognitionDocument = { engine: "pdf-text"|"vision"|"ofd-text"|"ofd-image"; pages: RecognitionPage[]; warnings: string[] }`

- [ ] **Step 1: Write failing OFD and recognizer-order tests**

```ts
it("extracts ordered TextCode content from OFD XML", async () => {
  const doc = await parseOfd(fixture("text.ofd"));
  expect(doc.pages[0].text).toContain("销售方名称：示例科技有限公司");
});

it("prefers a PDF text layer and does not invoke Vision", async () => {
  const result = await recognizeLocal(pdfSource, { native: fakeNativePdfText, ofd: fakeOfd });
  expect(result.engine).toBe("pdf-text");
  expect(fakeNativePdfText.visionCalls).toBe(0);
});
```

- [ ] **Step 2: Verify both tests fail**

Run: `pnpm vitest run tests/lib/ofd tests/lib/recognition/local-recognizer.test.ts`

Expected: FAIL because the OFD parser and recognizer are absent.

- [ ] **Step 3: Implement safe ZIP/XML extraction and fallback order**

Reject encrypted entries, absolute paths, `..`, more than 2,000 entries, or uncompressed content above 100 MiB. Resolve `OFD.xml → DocRoot → Pages/Page → Content.xml`, collect `TextCode` in page/position order, and extract only referenced PNG/JPEG resources. If no useful text exists, pass each referenced page image to Vision; if a vector-only page cannot be represented, return warning `OFD_PAGE_REQUIRES_MANUAL_OR_CLOUD`.

- [ ] **Step 4: Verify parsers and no-network guard**

Run: `pnpm vitest run tests/lib/ofd tests/lib/recognition && pnpm typecheck`

Expected: PASS; a test replaces global `fetch` with a throwing stub and local recognition still succeeds.

- [ ] **Step 5: Commit and push local document recognition**

```bash
git add src/lib/ofd src/lib/recognition tests/lib/ofd tests/lib/recognition tests/fixtures/invoices
git commit -m "feat: add offline pdf and ofd recognition pipeline"
git push origin HEAD
```

### Task 4: 发票字段解析、标准化与置信度

**Files:**
- Create: `src/lib/recognition/fields.ts`, `src/lib/recognition/parse-fields.ts`
- Create: `src/lib/recognition/normalize.ts`, `src/lib/recognition/confidence.ts`
- Create: `src/lib/recognition/fixtures.ts`
- Test: `tests/lib/recognition/parse-fields.test.ts`, `tests/lib/recognition/confidence.test.ts`

**Interfaces:**
- Produces: `InvoiceFields`, `InvoiceFieldKey`, `ParsedInvoiceDraft`
- Produces: `parseInvoiceFields(document: RecognitionDocument): ParsedInvoiceDraft`
- Produces: `requiresReview(draft: ParsedInvoiceDraft): InvoiceFieldKey[]`

- [ ] **Step 1: Write table-driven failing field tests**

```ts
it.each([
  ["开票日期：2026年08月28日", "issueDate", "2026-08-28"],
  ["发票号码：25112000000018475031", "invoiceNumber", "25112000000018475031"],
  ["价税合计（小写）¥1,280.00", "totalAmountCents", 128000]
])("parses %s", (line, key, expected) => {
  expect(parseInvoiceFields(documentWith(line)).fields[key]).toBe(expected);
});
```

- [ ] **Step 2: Confirm parser tests fail**

Run: `pnpm vitest run tests/lib/recognition/parse-fields.test.ts tests/lib/recognition/confidence.test.ts`

Expected: FAIL because `parseInvoiceFields` is missing.

- [ ] **Step 3: Implement explicit field and confidence types**

```ts
export type InvoiceFields = {
  invoiceType: string | null;
  issueDate: string | null;
  invoiceCode: string | null;
  invoiceNumber: string | null;
  uniqueVoucherNumber: string | null;
  sellerName: string | null;
  buyerName: string | null;
  amountExcludingTaxCents: number | null;
  taxCents: number | null;
  totalAmountCents: number | null;
};
export type ParsedInvoiceDraft = {
  fields: InvoiceFields;
  confidence: Record<keyof InvoiceFields, number>;
  warnings: string[];
};
```

Normalize full-width characters, whitespace, dates, currency separators and known invoice type aliases. Lower confidence when a regex-only match lacks a label, when OCR confidence is below 0.85, or when `不含税金额 + 税额 !== 价税合计` by more than 1 cent. Require review for date, type, seller, total and invoice/voucher number below 0.85 or null.

- [ ] **Step 4: Run parser and arithmetic consistency tests**

Run: `pnpm vitest run tests/lib/recognition && pnpm typecheck`

Expected: PASS for all table cases; no amount calculation uses a floating-point accumulator.

- [ ] **Step 5: Commit and push field parsing**

```bash
git add src/lib/recognition tests/lib/recognition
git commit -m "feat: parse and score invoice fields locally"
git push origin HEAD
```

### Task 5: 草稿任务、业务重复与确认入库

**Files:**
- Create: `src/lib/imports/service.ts`, `src/lib/imports/job-handler.ts`
- Create: `src/lib/drafts/repository.ts`, `src/lib/drafts/service.ts`
- Create: `src/lib/duplicates/business-match.ts`
- Create: `src/app/api/imports/[id]/route.ts`, `src/app/api/imports/[id]/confirm/route.ts`
- Test: `tests/lib/duplicates/business-match.test.ts`, `tests/lib/drafts/service.test.ts`
- Test: `tests/app/api/confirm-draft.test.ts`

**Interfaces:**
- Produces: `processRecognitionJob(sourceFileId: string): Promise<void>`
- Produces: `findBusinessDuplicates(fields: InvoiceFields): DuplicateCandidate[]`
- Produces: `confirmDraft(input: ConfirmDraftInput): Promise<ConfirmedInvoice>`
- Produces: `GET /api/imports/:id`, `POST /api/imports/:id/confirm`

- [ ] **Step 1: Write failing duplicate and transaction tests**

```ts
it("blocks equal code and number until a reason is supplied", async () => {
  await seedInvoice({ invoiceCode: "011001", invoiceNumber: "12345678" });
  await expect(confirmDraft({ draftId, edits: sameFields })).rejects.toMatchObject({ code: "DUPLICATE_INVOICE" });
  const kept = await confirmDraft({ draftId, edits: sameFields, forceKeepReason: "同号的更正票，已核对原件" });
  expect(kept.reimbursementStatus).toBe("pending");
});
```

- [ ] **Step 2: Run focused duplicate and confirmation tests**

Run: `pnpm vitest run tests/lib/duplicates tests/lib/drafts tests/app/api/confirm-draft.test.ts`

Expected: FAIL because matching and confirmation services do not exist.

- [ ] **Step 3: Implement job-to-draft and atomic confirmation**

The recognition handler stores normalized fields/confidence but not full OCR text. When every local recognizer fails, it still creates an editable empty draft with warning `LOCAL_RECOGNITION_FAILED`, enabling pure manual entry. Exact code+number is a hard match; when code is absent, match normalized number+date+total+type and seller. Confirmation validates all critical fields, requires a nonblank reason of at least 4 characters for force keep, and writes invoice, duplicate decision and initial status event in one transaction.

- [ ] **Step 4: Verify failure isolation and duplicate evidence**

Run: `pnpm vitest run tests/lib/imports tests/lib/duplicates tests/lib/drafts tests/app/api/confirm-draft.test.ts && pnpm typecheck`

Expected: PASS; one failed recognition job does not alter another source/draft.

- [ ] **Step 5: Commit and push the draft workflow**

```bash
git add src/lib/imports src/lib/drafts src/lib/duplicates src/app/api/imports tests/lib tests/app/api/confirm-draft.test.ts
git commit -m "feat: review and confirm recognized invoices"
git push origin HEAD
```

### Task 6: 手动腾讯云兜底与钥匙串设置

**Files:**
- Create: `src/lib/cloud-ocr/provider.ts`, `src/lib/cloud-ocr/tencent.ts`, `src/lib/cloud-ocr/map-tencent.ts`
- Create: `src/lib/cloud-ocr/credentials.ts`, `src/lib/cloud-ocr/service.ts`
- Create: `src/app/api/cloud-ocr/settings/route.ts`
- Create: `src/app/api/imports/[id]/cloud-recognition/route.ts`
- Test: `tests/lib/cloud-ocr/tencent.test.ts`, `tests/lib/cloud-ocr/service.test.ts`
- Test: `tests/app/api/cloud-recognition.test.ts`

**Interfaces:**
- Produces: `CloudOcrProvider.recognize(input: CloudRecognitionInput): Promise<CloudRecognitionResult>`
- Produces: `POST /api/cloud-ocr/settings` storing SecretId/SecretKey in Keychain
- Produces: `POST /api/imports/:id/cloud-recognition` body `{ confirmedFileId: string; provider: "tencent" }`
- Consumes: Tencent `RecognizeGeneralInvoice`, API version `2018-11-19`, endpoint `ocr.tencentcloudapi.com`

- [ ] **Step 1: Write failing explicit-confirmation and adapter tests**

```ts
it("never calls the provider without a matching confirmed file id", async () => {
  await expect(requestCloudRecognition({ invoiceId, confirmedFileId: "other", provider: "tencent" }))
    .rejects.toMatchObject({ code: "CLOUD_CONFIRMATION_MISMATCH" });
  expect(fakeProvider.calls).toHaveLength(0);
});

it("sends base64 bytes to RecognizeGeneralInvoice", async () => {
  await provider.recognize({ bytes: Buffer.from("fixture"), format: "pdf" });
  expect(client.RecognizeGeneralInvoice).toHaveBeenCalledWith({
    ImageBase64: Buffer.from("fixture").toString("base64"), EnableMultiplePage: true
  });
});
```

- [ ] **Step 2: Run cloud tests and verify no provider call occurs**

Run: `pnpm vitest run tests/lib/cloud-ocr tests/app/api/cloud-recognition.test.ts`

Expected: FAIL because the provider and confirmation endpoint are missing.

- [ ] **Step 3: Implement Keychain credentials and Tencent mapping**

Store SecretId and SecretKey as separate Keychain accounts through the native stdin protocol. Use `RecognizeGeneralInvoice` with `ImageBase64`, `EnableMultiplePage: true`; map `MixedInvoiceItems` into `InvoiceFields`, save only `RequestId`, normalized fields and warnings, and never persist the base64 request or raw response. Provider errors become stable local codes plus the Tencent RequestId when present.

- [ ] **Step 4: Verify the manual-only network boundary**

Run: `pnpm vitest run tests/lib/cloud-ocr tests/app/api/cloud-recognition.test.ts && pnpm typecheck`

Expected: PASS; tests prove local recognition does not construct a Tencent client, mismatched confirmation is 409, and credentials do not appear in SQLite/log snapshots.

- [ ] **Step 5: Commit and push cloud fallback**

```bash
git add src/lib/cloud-ocr src/app/api/cloud-ocr src/app/api/imports tests/lib/cloud-ocr tests/app/api/cloud-recognition.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add confirmed tencent ocr fallback"
git push origin HEAD
```

### Task 7: 上传、进度与校对页面

**Files:**
- Create: `src/app/upload/page.tsx`, `src/components/upload/upload-dropzone.tsx`
- Create: `src/components/upload/import-list.tsx`, `src/components/upload/draft-editor.tsx`
- Create: `src/components/upload/cloud-confirm-dialog.tsx`, `src/components/settings/cloud-ocr-settings.tsx`
- Create: `src/lib/client/import-api.ts`
- Test: `tests/components/upload/upload-dropzone.test.tsx`, `tests/components/upload/draft-editor.test.tsx`
- Test: `tests/e2e/import-review.spec.ts`

**Interfaces:**
- Consumes: import upload/status/confirm APIs and explicit cloud confirmation API
- Produces: browser batch controller with at most 100 files and upload concurrency 2
- Produces: `pnpm test:e2e --grep @ingestion`

- [ ] **Step 1: Write failing UI tests**

```tsx
it("rejects the 101st file and keeps valid files available", async () => {
  render(<UploadDropzone onAccepted={accepted} />);
  await selectFiles(makeFiles(101));
  expect(screen.getByText("单批最多选择 100 个文件")).toBeVisible();
  expect(accepted).toHaveBeenCalledWith(expect.arrayContaining(makeExpectedFirst100()));
});

it("requires a second confirmation before cloud recognition", async () => {
  render(<CloudConfirmDialog invoice={invoice} onConfirm={confirm} />);
  expect(screen.getByText(/将发送给腾讯云/)).toBeVisible();
  expect(confirm).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run component tests and observe failure**

Run: `pnpm vitest run tests/components/upload`

Expected: FAIL because upload components do not exist.

- [ ] **Step 3: Implement per-file progress and accessible review forms**

Show `等待上传/校验中/本地识别中/待校对/重复/失败/已入库`. Poll only active IDs with exponential backoff capped at 2 seconds. A locally failed item offers `手工录入` and opens the empty draft editor. Mark required or confidence <0.85 fields in yellow with text labels. The cloud button opens a dialog naming the file, provider and affected draft fields; only its final confirm calls the endpoint.

- [ ] **Step 4: Add the end-to-end ingestion journey**

```ts
test("@ingestion imports, reviews, blocks duplicate, and confirms", async ({ page }) => {
  await page.goto("/upload");
  await page.getByLabel("选择发票文件").setInputFiles("tests/fixtures/invoices/minimal.pdf");
  await expect(page.getByText("待校对")).toBeVisible();
  await page.getByLabel("开票方名称").fill("示例科技有限公司");
  await page.getByRole("button", { name: "确认入库" }).click();
  await expect(page.getByText("已入库")).toBeVisible();
});
```

- [ ] **Step 5: Run the complete ingestion gate**

Run: `pnpm vitest run tests/components/upload && pnpm test:e2e --grep @ingestion && pnpm verify && git diff --check`

Expected: PASS; no test uses a real cloud credential or sends an external request.

- [ ] **Step 6: Commit and push the completed ingestion flow**

```bash
git add src/app/upload src/components/upload src/components/settings src/lib/client tests/components/upload tests/e2e/import-review.spec.ts
git commit -m "feat: add invoice upload and review workspace"
git push origin HEAD
```

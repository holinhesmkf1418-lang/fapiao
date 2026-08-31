# 本地发票管理与统计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供发票查询、批量报销状态管理、统计总览、可访问图表和可恢复删除。

**Architecture:** 所有列表与统计共用一个类型化筛选对象和同一组 SQLite 查询，保证金额口径一致。删除使用“恢复记录 → 移入 macOS 废纸篓 → 数据库事务”的顺序；启动维护任务负责收敛未完成操作。

**Tech Stack:** Next.js、React、SQLite/Drizzle、Zod、Recharts、Testing Library、Vitest、Playwright

**Spec:** `docs/product-design.md`

## Global Constraints

- 报销状态固定为 `待报销 → 报销中 → 已报销`，允许纠正性回退。
- 总览与列表金额都按价税合计整数分聚合，不使用浮点数累计。
- 支持月份、类型、报销状态和关键词筛选；图表点击必须能联动明细。
- 图表同时显示文字图例、金额、数量和比例，不能只依靠颜色。
- 删除只影响工作台管理副本，原始来源文件永远不受影响。
- 管理副本只移入 macOS 废纸篓，不执行不可恢复删除。
- 每个 Task 通过验证后独立提交并运行 `git push origin HEAD`。

---

## File Structure

```text
src/lib/invoices/filters.ts            # 列表与统计共用筛选对象
src/lib/invoices/repository.ts         # 分页、详情、批量状态查询
src/lib/invoices/status-service.ts     # 状态变更事务和历史
src/lib/dashboard/query.ts             # 指标与图表聚合
src/lib/deletion/                      # 废纸篓、恢复记录和启动重试
src/app/api/invoices/                  # 列表、详情、状态、删除 API
src/app/api/dashboard/                 # 统一统计 API
src/app/invoices/                      # 发票管理页面
src/app/page.tsx                       # 总览页面
src/components/charts/                 # 可访问图表
```

## Shared Interfaces

```ts
export type ReimbursementStatus = "pending" | "reimbursing" | "reimbursed";
export type InvoiceFilters = { month?: string; types: string[]; statuses: ReimbursementStatus[]; keyword?: string };
export type InvoiceListItem = {
  id: string; invoiceType: string; issueDate: string; invoiceNumber: string | null;
  uniqueVoucherNumber: string | null; sellerName: string; totalAmountCents: number;
  reimbursementStatus: ReimbursementStatus;
};
export type InvoicePage = { items: InvoiceListItem[]; nextCursor: string | null; totalCount: number };
export type StatusChangeResult = { changed: number; unchanged: number };
export type AmountBucket = { key: string; label: string; amountCents: number; count: number };
export type DashboardData = {
  totals: { amountCents: number; count: number };
  byStatus: AmountBucket[]; byMonth: AmountBucket[]; byType: AmountBucket[];
};
export type RecoverySummary = { completed: number; cancelled: number; needsAttention: number };
```

### Task 1: 共用筛选、分页查询与原件预览

**Files:**
- Create: `src/lib/invoices/types.ts`, `src/lib/invoices/filters.ts`, `src/lib/invoices/repository.ts`
- Create: `src/app/api/invoices/route.ts`, `src/app/api/invoices/[id]/route.ts`
- Create: `src/app/api/invoices/[id]/file/route.ts`
- Test: `tests/lib/invoices/repository.test.ts`, `tests/app/api/invoices.test.ts`

**Interfaces:**
- Produces: `InvoiceFilters = { month?: string; types: string[]; statuses: ReimbursementStatus[]; keyword?: string }`
- Produces: `listInvoices(filters, page): Promise<InvoicePage>`
- Produces: `GET /api/invoices`, `GET /api/invoices/:id`, `GET /api/invoices/:id/file`

- [ ] **Step 1: Write failing filter and pagination tests**

```ts
it("applies month, type, status, and escaped keyword together", async () => {
  await seedInvoices(sampleInvoices);
  const page = await listInvoices({
    month: "2026-08", types: ["增值税普通发票"], statuses: ["pending"], keyword: "示例%"
  }, { cursor: null, limit: 20 });
  expect(page.items.map((item) => item.id)).toEqual(["invoice-matching-literal-percent"]);
});
```

- [ ] **Step 2: Run focused repository/API tests**

Run: `pnpm vitest run tests/lib/invoices tests/app/api/invoices.test.ts`

Expected: FAIL because filters and repository do not exist.

- [ ] **Step 3: Implement one validated query contract**

Use Zod to accept `month` as `YYYY-MM`, repeated type/status values, keyword length 1–100, and cursor pagination. Escape `%`, `_`, and `\` before `LIKE ... ESCAPE '\'`. Return 50 rows by default and at most 200. The file route resolves the managed path with `assertInsideWorkRoot`, uses an inline content disposition, and never exposes the absolute path.

- [ ] **Step 4: Verify filter combinations and containment**

Run: `pnpm vitest run tests/lib/invoices tests/app/api/invoices.test.ts && pnpm typecheck`

Expected: PASS; invalid cursors are 400 and a forged outside path is 403.

- [ ] **Step 5: Commit and push invoice queries**

```bash
git add src/lib/invoices src/app/api/invoices tests/lib/invoices tests/app/api/invoices.test.ts
git commit -m "feat: query and preview local invoices"
git push origin HEAD
```

### Task 2: 单张与批量报销状态变更

**Files:**
- Create: `src/lib/invoices/status-service.ts`
- Create: `src/app/api/invoices/status/route.ts`
- Test: `tests/lib/invoices/status-service.test.ts`, `tests/app/api/invoice-status.test.ts`

**Interfaces:**
- Produces: `ReimbursementStatus = "pending" | "reimbursing" | "reimbursed"`
- Produces: `changeInvoiceStatuses(input: { ids: string[]; to: ReimbursementStatus }): Promise<StatusChangeResult>`
- Produces: `PATCH /api/invoices/status` body `{ ids: string[]; to: ReimbursementStatus }`

- [ ] **Step 1: Write failing atomic status-history test**

```ts
it("changes a batch and records every transition in one transaction", async () => {
  const result = await changeInvoiceStatuses({ ids: ["a", "b"], to: "reimbursed" });
  expect(result).toEqual({ changed: 2, unchanged: 0 });
  expect(await statusEvents()).toMatchObject([
    { invoiceId: "a", fromStatus: "pending", toStatus: "reimbursed" },
    { invoiceId: "b", fromStatus: "reimbursing", toStatus: "reimbursed" }
  ]);
});
```

- [ ] **Step 2: Run status tests and verify failure**

Run: `pnpm vitest run tests/lib/invoices/status-service.test.ts tests/app/api/invoice-status.test.ts`

Expected: FAIL because the service and route are missing.

- [ ] **Step 3: Implement validated batch mutation**

Allow 1–200 unique IDs. Read current rows, insert events only for changed rows, and update them in one SQLite transaction. Missing IDs abort the entire batch with `INVOICE_NOT_FOUND`; direct transitions and corrective rollbacks are both allowed.

- [ ] **Step 4: Verify rollback and no-op behavior**

Run: `pnpm vitest run tests/lib/invoices/status-service.test.ts tests/app/api/invoice-status.test.ts && pnpm typecheck`

Expected: PASS; a missing ID leaves all selected invoices unchanged and same-status changes create no event.

- [ ] **Step 5: Commit and push status workflow**

```bash
git add src/lib/invoices/status-service.ts src/app/api/invoices/status tests/lib/invoices/status-service.test.ts tests/app/api/invoice-status.test.ts
git commit -m "feat: manage invoice reimbursement statuses"
git push origin HEAD
```

### Task 3: 统一统计查询

**Files:**
- Create: `src/lib/dashboard/types.ts`, `src/lib/dashboard/query.ts`
- Create: `src/app/api/dashboard/route.ts`
- Test: `tests/lib/dashboard/query.test.ts`, `tests/app/api/dashboard.test.ts`

**Interfaces:**
- Produces: `getDashboard(filters: InvoiceFilters): Promise<DashboardData>`
- Produces: `DashboardData = { totals; byStatus; byMonth; byType }`
- Produces: `GET /api/dashboard` using the exact `InvoiceFilters` parser

- [ ] **Step 1: Write failing integer aggregation tests**

```ts
it("returns totals whose status and type buckets reconcile", async () => {
  await seedInvoices([
    invoice({ totalAmountCents: 10001, status: "pending", type: "火车票" }),
    invoice({ totalAmountCents: 20002, status: "reimbursed", type: "火车票" })
  ]);
  const data = await getDashboard({ month: "2026-08", types: [], statuses: [] });
  expect(data.totals).toEqual({ amountCents: 30003, count: 2 });
  expect(sumCents(data.byStatus)).toBe(30003);
  expect(sumCents(data.byType)).toBe(30003);
});
```

- [ ] **Step 2: Run dashboard tests and observe missing query failure**

Run: `pnpm vitest run tests/lib/dashboard tests/app/api/dashboard.test.ts`

Expected: FAIL because dashboard modules are absent.

- [ ] **Step 3: Implement shared WHERE clauses and zero buckets**

Build the SQL predicate once from `InvoiceFilters` and reuse it for totals, status, month and type queries. Return all three status buckets even at zero. Keep `amountCents` as SQLite integers and calculate display percentages only in the UI with the rule `total === 0 ? 0 : value / total`.

- [ ] **Step 4: Verify statistics against list results**

Run: `pnpm vitest run tests/lib/dashboard tests/app/api/dashboard.test.ts && pnpm typecheck`

Expected: PASS; property tests show the filtered list sum equals dashboard total for each fixture dataset.

- [ ] **Step 5: Commit and push dashboard queries**

```bash
git add src/lib/dashboard src/app/api/dashboard tests/lib/dashboard tests/app/api/dashboard.test.ts
git commit -m "feat: add consistent invoice dashboard metrics"
git push origin HEAD
```

### Task 4: 发票管理页面与批量操作

**Files:**
- Create: `src/app/invoices/page.tsx`, `src/app/invoices/[id]/page.tsx`
- Create: `src/components/invoices/filter-bar.tsx`, `src/components/invoices/invoice-table.tsx`
- Create: `src/components/invoices/bulk-status-bar.tsx`, `src/components/invoices/invoice-detail.tsx`
- Create: `src/lib/client/invoice-api.ts`
- Test: `tests/components/invoices/filter-bar.test.tsx`, `tests/components/invoices/invoice-table.test.tsx`
- Test: `tests/e2e/invoice-management.spec.ts`

**Interfaces:**
- Consumes: invoice query, file preview, detail, and status APIs
- Produces: URL-backed filters and selected-ID batch status actions
- Produces: `pnpm test:e2e --grep @management`

- [ ] **Step 1: Write failing component tests**

```tsx
it("keeps filters in the URL and clears selection after a batch update", async () => {
  render(<InvoiceManagement initialData={data} />);
  await user.selectOptions(screen.getByLabelText("报销状态"), "待报销");
  expect(mockRouter.replace).toHaveBeenCalledWith(expect.stringContaining("status=pending"));
  await selectRows(["a", "b"]);
  await user.click(screen.getByRole("button", { name: "标记为已报销" }));
  expect(screen.getByText("已选择 0 张")).toBeVisible();
});
```

- [ ] **Step 2: Run management component tests**

Run: `pnpm vitest run tests/components/invoices`

Expected: FAIL because the management components are absent.

- [ ] **Step 3: Implement responsive list, detail and status feedback**

Desktop uses a selectable table; narrow screens use cards with the same fields/actions. Debounce keyword changes by 250 ms, reset the cursor on any filter change, preserve filters in query parameters, and announce mutation success/failure through an `aria-live` region. Open the original through the protected inline file route.

- [ ] **Step 4: Add and run management journey**

```ts
test("@management filters and updates selected invoices", async ({ page }) => {
  await page.goto("/invoices?month=2026-08");
  await page.getByRole("checkbox", { name: /选择发票/ }).first().check();
  await page.getByRole("button", { name: "标记为报销中" }).click();
  await expect(page.getByText("已更新 1 张发票")).toBeVisible();
});
```

Run: `pnpm vitest run tests/components/invoices && pnpm test:e2e --grep @management`

Expected: PASS at desktop and 390px viewports.

- [ ] **Step 5: Commit and push management UI**

```bash
git add src/app/invoices src/components/invoices src/lib/client/invoice-api.ts tests/components/invoices tests/e2e/invoice-management.spec.ts
git commit -m "feat: add responsive invoice management"
git push origin HEAD
```

### Task 5: 总览指标与可访问图表

**Files:**
- Modify: `src/app/page.tsx`
- Create: `src/components/dashboard/summary-cards.tsx`, `src/components/dashboard/dashboard-filters.tsx`
- Create: `src/components/charts/monthly-stacked-bar.tsx`, `src/components/charts/type-donut.tsx`, `src/components/charts/status-donut.tsx`
- Create: `src/components/charts/accessible-legend.tsx`
- Test: `tests/components/dashboard/dashboard.test.tsx`, `tests/components/charts/accessible-legend.test.tsx`
- Test: `tests/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: `DashboardData` and common filter query parameters
- Produces: chart segment links to `/invoices` with matching month/type/status filters
- Produces: `pnpm test:e2e --grep @dashboard`

- [ ] **Step 1: Write failing accessibility and reconciliation tests**

```tsx
it("shows amount, count and percentage as text for every type", () => {
  render(<TypeDonut items={[{ type: "火车票", amountCents: 2500, count: 2 }]} totalCents={10000} />);
  expect(screen.getByText("火车票")).toBeVisible();
  expect(screen.getByText("¥25.00")).toBeVisible();
  expect(screen.getByText("2 张 · 25.0%")).toBeVisible();
});
```

- [ ] **Step 2: Run chart tests and verify failure**

Run: `pnpm vitest run tests/components/dashboard tests/components/charts`

Expected: FAIL because dashboard components are missing.

- [ ] **Step 3: Implement summaries, charts and text equivalents**

Render cards for total and all three statuses. The monthly chart stacks status cents; type/status donuts use a stable palette and always render an adjacent semantic list. Every segment and legend row is keyboard reachable and links to the corresponding filtered invoice list. Empty data shows `当前范围暂无发票` instead of a zero-radius chart.

- [ ] **Step 4: Run dashboard component and journey tests**

```ts
test("@dashboard chart navigation opens matching details", async ({ page }) => {
  await page.goto("/?month=2026-08");
  await page.getByRole("link", { name: /火车票.*25\.0%/ }).click();
  await expect(page).toHaveURL(/\/invoices\?.*type=/);
});
```

Run: `pnpm vitest run tests/components/dashboard tests/components/charts && pnpm test:e2e --grep @dashboard`

Expected: PASS with both visual charts and complete textual equivalents.

- [ ] **Step 5: Commit and push the dashboard**

```bash
git add src/app/page.tsx src/components/dashboard src/components/charts tests/components/dashboard tests/components/charts tests/e2e/dashboard.spec.ts package.json pnpm-lock.yaml
git commit -m "feat: add accessible invoice dashboard"
git push origin HEAD
```

### Task 6: 可恢复删除与启动收敛

**Files:**
- Create: `src/lib/deletion/types.ts`, `src/lib/deletion/trash.ts`, `src/lib/deletion/service.ts`, `src/lib/deletion/recover.ts`
- Create: `src/app/api/invoices/[id]/delete/route.ts`
- Create: `src/components/invoices/delete-dialog.tsx`
- Test: `tests/lib/deletion/service.test.ts`, `tests/lib/deletion/recover.test.ts`
- Test: `tests/e2e/invoice-deletion.spec.ts`
- Modify: `src/lib/runtime/context.ts`

**Interfaces:**
- Produces: `deleteInvoice(id: string): Promise<{ status: "deleted" | "incomplete" }>`
- Produces: `recoverPendingDeletions(): Promise<RecoverySummary>`
- Produces: `moveToTrash(path: string): Promise<string>` returning the recoverable Trash path/receipt
- Produces: `DELETE /api/invoices/:id/delete`

- [ ] **Step 1: Write failing operation-order tests**

```ts
it("records recovery, moves the managed copy, then commits row deletion", async () => {
  await deleteInvoice("invoice-a");
  expect(events).toEqual(["recovery-created", "file-trashed", "db-transaction-committed"]);
  expect(sourceOriginalExists()).toBe(true);
});

it("retains recovery evidence when the database transaction fails", async () => {
  db.failNextTransaction();
  await expect(deleteInvoice("invoice-a")).resolves.toEqual({ status: "incomplete" });
  expect(await recoveryRecord("invoice-a")).toMatchObject({ stage: "file_trashed" });
});
```

- [ ] **Step 2: Run deletion tests and observe failure**

Run: `pnpm vitest run tests/lib/deletion`

Expected: FAIL because deletion modules do not exist.

- [ ] **Step 3: Implement Trash move and recovery state machine**

Use a native macOS operation (`NSWorkspace.recycle`) through the Swift helper so the result is recoverable. State transitions are `prepared → file_trashed → completed|needs_attention`. Only after `file_trashed` delete invoice, draft, jobs, duplicate links and source row in one transaction. Startup retries database finalization; if the file move never happened it may safely cancel the recovery record.

- [ ] **Step 4: Add UI confirmation and run deletion journey**

```ts
test("@management deletes only after naming the consequence", async ({ page }) => {
  await page.goto(`/invoices/${invoiceId}`);
  await page.getByRole("button", { name: "删除发票" }).click();
  await expect(page.getByText("原位置文件不会删除，工作台副本将移入废纸篓")).toBeVisible();
  await page.getByRole("button", { name: "移入废纸篓" }).click();
  await expect(page.getByText("已移入废纸篓")).toBeVisible();
});
```

Run: `pnpm vitest run tests/lib/deletion && pnpm test:e2e --grep @management && pnpm verify`

Expected: PASS; fixture source file remains and managed copy is absent from the work root.

- [ ] **Step 5: Commit and push deletion recovery**

```bash
git add src/lib/deletion src/app/api/invoices src/components/invoices/delete-dialog.tsx src/lib/runtime/context.ts tests/lib/deletion tests/e2e/invoice-deletion.spec.ts native/InvoiceNative
git commit -m "feat: add recoverable invoice deletion"
git push origin HEAD
```

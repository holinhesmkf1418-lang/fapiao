# 发票管理与统计工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付发票查询筛选、批量状态管理、金额统计、交互图表和安全删除功能。

**Architecture:** 所有筛选条件进入服务端查询对象，列表和统计复用同一过滤构造器，避免页面与图表口径分叉。状态变更与删除通过服务层执行所有权校验和事务，React Server Components 负责首屏数据，客户端组件只处理交互和图表。

**Tech Stack:** Next.js 16、Drizzle ORM、PostgreSQL、Zod、Recharts、Vitest、Testing Library、Playwright

**Spec:** `docs/product-design.md`

## Global Constraints

- 所有金额统计使用价税合计，只统计当前用户正式入库的发票。
- 默认范围为当前自然月，支持指定月份和全年。
- 状态固定为待报销、报销中、已报销，允许纠正性回退。
- 图表必须同时提供文字图例和数值，不只依赖颜色。
- 列表和图表必须使用同一服务端过滤口径。
- 删除成功必须同时删除业务记录、原始对象与识别关联；部分失败不能显示为成功。

---

### Task 1: 发票查询对象、分页与筛选 API

**Files:**
- Create: `src/invoices/query.ts`
- Create: `src/invoices/query.test.ts`
- Create: `src/app/api/invoices/route.ts`

**Interfaces:**
- Consumes: `invoices`、当前会话用户。
- Produces: `InvoiceFilters`；`listInvoices({ userId, filters, page, pageSize }): InvoicePage`。

- [ ] **Step 1: 写筛选隔离测试**

```ts
test("filters by month, type and status for the current user", async () => {
  await seedInvoice({ userId: "u1", date: "2026-08-01", type: "railway", status: "pending" });
  await seedInvoice({ userId: "u1", date: "2026-07-01", type: "railway", status: "pending" });
  await seedInvoice({ userId: "u2", date: "2026-08-01", type: "railway", status: "pending" });
  const page = await listInvoices({ userId: "u1", filters: { month: "2026-08", type: "railway", status: "pending" }, page: 1, pageSize: 20 });
  expect(page.total).toBe(1);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/invoices/query.test.ts`

Expected: FAIL，查询模块不存在。

- [ ] **Step 3: 实现查询对象和分页结果**

```ts
export const invoiceFiltersSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  type: z.enum(invoiceTypes).optional(),
  status: z.enum(invoiceStatuses).optional(),
  q: z.string().trim().max(100).optional(),
}).refine((value) => !(value.month && value.year), "month and year are mutually exclusive");

export type InvoicePage = { items: InvoiceListItem[]; page: number; pageSize: number; total: number; totalPages: number };
```

Build a shared `invoiceWhere(userId, filters)` that always starts with `eq(invoices.userId, userId)`. Search `q` against seller name, invoice number and invoice code using escaped `ILIKE`. Sort by invoice date descending then creation time descending. API page size options are 20, 50, 100; reject all other values.

- [ ] **Step 4: 验证**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/invoices/query.test.ts && pnpm typecheck`

Expected: PASS；无筛选条件也不能返回其他用户数据。

- [ ] **Step 5: 提交**

```bash
git add src/invoices/query.ts src/invoices/query.test.ts src/app/api/invoices
git commit -m "feat: query and filter owned invoices"
```

---

### Task 2: 单张与批量报销状态变更

**Files:**
- Modify: `src/db/schema/invoices.ts`
- Create: `drizzle/0002_invoice_status_events.sql` (generated)
- Create: `src/invoices/update-status.ts`
- Create: `src/invoices/update-status.test.ts`
- Create: `src/app/api/invoices/status/route.ts`

**Interfaces:**
- Consumes: 当前用户、最多 100 个发票 ID、目标状态。
- Produces: `updateInvoiceStatus(input): Promise<{ updatedIds: string[] }>`；`invoice_status_events` 审计记录。

- [ ] **Step 1: 写原子批量更新测试**

```ts
test("rejects the whole batch when one invoice is not owned", async () => {
  const mine = await seedInvoice({ userId: "u1", status: "pending" });
  const theirs = await seedInvoice({ userId: "u2", status: "pending" });
  await expect(updateInvoiceStatus({ userId: "u1", invoiceIds: [mine.id, theirs.id], status: "in_progress" })).rejects.toMatchObject({ code: "INVOICE_NOT_FOUND" });
  expect(await getStatus(mine.id)).toBe("pending");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/invoices/update-status.test.ts`

Expected: FAIL，服务不存在。

- [ ] **Step 3: 实现事务和事件表**

```ts
const updateStatusInput = z.object({
  invoiceIds: z.array(z.string().uuid()).min(1).max(100),
  status: z.enum(invoiceStatuses),
});
```

Inside one transaction, select all requested IDs with `userId`, require exact count, update status and `updatedAt`, then insert one event per changed invoice with `fromStatus`, `toStatus`, `changedBy`, and timestamp. IDs already in the target state are returned but do not create duplicate events.

- [ ] **Step 4: 生成 migration 并验证**

Run: `pnpm db:generate -- --name invoice_status_events && DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/invoices/update-status.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/db/schema src/invoices/update-status.ts src/invoices/update-status.test.ts src/app/api/invoices/status drizzle
git commit -m "feat: update reimbursement status in batches"
```

---

### Task 3: 统一统计查询

**Files:**
- Create: `src/dashboard/stats.ts`
- Create: `src/dashboard/stats.test.ts`
- Create: `src/app/api/dashboard/route.ts`

**Interfaces:**
- Consumes: `invoiceWhere(userId, filters)`。
- Produces: `getDashboardStats({ userId, range }): DashboardStats`。

- [ ] **Step 1: 写金额口径测试**

```ts
test("uses exact decimal totals for cards and charts", async () => {
  await seedInvoice({ userId: "u1", date: "2026-08-02", type: "vat_normal", status: "pending", total: "0.10" });
  await seedInvoice({ userId: "u1", date: "2026-08-03", type: "vat_normal", status: "reimbursed", total: "0.20" });
  const stats = await getDashboardStats({ userId: "u1", range: { month: "2026-08" } });
  expect(stats.summary.totalAmount).toBe("0.30");
  expect(stats.byType[0]).toMatchObject({ type: "vat_normal", amount: "0.30", count: 2 });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/dashboard/stats.test.ts`

Expected: FAIL，统计模块不存在。

- [ ] **Step 3: 实现聚合返回类型**

```ts
export type DashboardStats = {
  summary: { totalAmount: string; totalCount: number; byStatus: Record<InvoiceStatus, { amount: string; count: number }> };
  monthly: Array<{ month: string; pending: string; inProgress: string; reimbursed: string }>;
  byType: Array<{ type: InvoiceType; amount: string; count: number }>;
  byStatus: Array<{ status: InvoiceStatus; amount: string; count: number }>;
};
```

Use PostgreSQL `sum(numeric)` and return strings. Fill absent status keys and missing months with zero values so charts do not invent gaps. Default month uses Asia/Shanghai calendar boundaries calculated server-side.

- [ ] **Step 4: 验证**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/dashboard/stats.test.ts && pnpm typecheck`

Expected: PASS；summary、byType、byStatus totals are equal for the same filter.

- [ ] **Step 5: 提交**

```bash
git add src/dashboard src/app/api/dashboard
git commit -m "feat: aggregate invoice dashboard statistics"
```

---

### Task 4: 发票管理列表与批量状态 UI

**Files:**
- Create: `src/app/(workbench)/invoices/page.tsx`
- Create: `src/components/invoices/invoice-filters.tsx`
- Create: `src/components/invoices/invoice-table.tsx`
- Create: `src/components/invoices/invoice-table.test.tsx`
- Create: `src/components/invoices/status-menu.tsx`
- Create: `src/components/invoices/pagination.tsx`

**Interfaces:**
- Consumes: URL filters、`listInvoices`、status API。
- Produces: 可搜索、筛选、分页、选择和批量改状态的 `/invoices` 页面。

- [ ] **Step 1: 写选择与批量操作测试**

```tsx
test("updates only selected invoices", async () => {
  const update = vi.fn().mockResolvedValue({ updatedIds: ["i1"] });
  render(<InvoiceTable items={[invoice("i1"), invoice("i2")]} updateStatus={update} />);
  await userEvent.click(screen.getByLabelText("选择发票 i1"));
  await userEvent.click(screen.getByRole("button", { name: "标记为报销中" }));
  expect(update).toHaveBeenCalledWith(["i1"], "in_progress");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/components/invoices/invoice-table.test.tsx`

Expected: FAIL，列表组件不存在。

- [ ] **Step 3: 实现列表**

Filters write `month|year|type|status|q|page` to the URL and reset page to 1 when filter values change. Table columns are type, invoice number, seller, date, total amount, status and actions. Keep selection scoped to the current page, show selected count, require confirmation for batch actions, and announce completion through `aria-live="polite"`.

```tsx
async function applyStatus(status: InvoiceStatus) {
  const invoiceIds = [...selectedIds];
  if (invoiceIds.length === 0) return;
  await updateStatus(invoiceIds, status);
  setSelectedIds(new Set());
  setAnnouncement(`已更新 ${invoiceIds.length} 张发票`);
  router.refresh();
}
```

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/components/invoices && pnpm lint && pnpm typecheck`

Expected: PASS；键盘可以使用筛选器、复选框和状态菜单。

- [ ] **Step 5: 提交**

```bash
git add src/app/'(workbench)'/invoices src/components/invoices
git commit -m "feat: add invoice management table"
```

---

### Task 5: 总览指标与可访问图表

**Files:**
- Modify: `package.json`
- Modify: `src/app/(workbench)/dashboard/page.tsx`
- Create: `src/components/dashboard/summary-cards.tsx`
- Create: `src/components/dashboard/monthly-chart.tsx`
- Create: `src/components/dashboard/type-chart.tsx`
- Create: `src/components/dashboard/status-chart.tsx`
- Create: `src/components/dashboard/dashboard.test.tsx`
- Create: `src/components/dashboard/dashboard.module.css`

**Interfaces:**
- Consumes: `DashboardStats`。
- Produces: 顶部指标、月度堆叠柱状图、类型饼图、状态饼图；点击后导航到筛选后的 `/invoices`。

- [ ] **Step 1: 写文字备选与联动测试**

```tsx
test("renders chart values as text and links a type to the invoice list", () => {
  render(<TypeChart data={[{ type: "railway", amount: "553.00", count: 1 }]} mode="amount" />);
  expect(screen.getByText("铁路电子客票 100% · ¥553.00")).toBeVisible();
  expect(screen.getByRole("link", { name: /铁路电子客票/ })).toHaveAttribute("href", expect.stringContaining("type=railway"));
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/components/dashboard/dashboard.test.tsx`

Expected: FAIL，图表不存在。

- [ ] **Step 3: 安装 Recharts 并实现**

Run: `pnpm add recharts`

Use `ResponsiveContainer`; stacked bars use the three status series, pie slices use type/status. Provide an adjacent semantic list containing label, amount, count and percentage. Type chart offers `按金额` and `按数量`; this is presentation-only and must not trigger a second API request. Use the accepted prototype colors and collapse the dashboard to one column at 760px.

```tsx
<ResponsiveContainer width="100%" height={240}>
  <BarChart data={data} accessibilityLayer>
    <XAxis dataKey="month" /><YAxis />
    <Bar dataKey="pending" stackId="status" name="待报销" fill="#3869eb" />
    <Bar dataKey="inProgress" stackId="status" name="报销中" fill="#6f91f1" />
    <Bar dataKey="reimbursed" stackId="status" name="已报销" fill="#9fb4ef" />
  </BarChart>
</ResponsiveContainer>
```

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/components/dashboard && pnpm typecheck && pnpm build`

Expected: PASS；zero-data state says `当前范围暂无发票` and renders no misleading 0% pie.

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml src/app/'(workbench)'/dashboard src/components/dashboard
git commit -m "feat: add responsive invoice dashboard"
```

---

### Task 6: 安全删除与管理阶段端到端验收

**Files:**
- Modify: `src/db/schema/invoices.ts`
- Create: `drizzle/0003_deletion_recoveries.sql` (generated)
- Create: `src/invoices/delete-invoice.ts`
- Create: `src/invoices/delete-invoice.test.ts`
- Create: `src/app/api/invoices/[invoiceId]/route.ts`
- Create: `src/components/invoices/delete-invoice-dialog.tsx`
- Create: `e2e/management-dashboard.spec.ts`

**Interfaces:**
- Consumes: 当前用户、invoice ID、ObjectStore。
- Produces: `deleteInvoice({ userId, invoiceId })`；仅在数据库与对象删除均完成后返回成功。

- [ ] **Step 1: 写部分失败测试**

```ts
test("does not report success when object deletion fails", async () => {
  const invoice = await seedInvoice({ userId: "u1" });
  objectStore.delete.mockRejectedValue(new Error("storage unavailable"));
  await expect(deleteInvoice({ userId: "u1", invoiceId: invoice.id })).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
  expect(await findInvoice(invoice.id)).not.toBeNull();
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `DATABASE_URL=$DATABASE_URL_TEST pnpm test -- src/invoices/delete-invoice.test.ts`

Expected: FAIL，删除服务不存在。

- [ ] **Step 3: 实现删除协调**

Add `deletion_recoveries(id, user_id, invoice_id, storage_key, state, last_error, created_at, updated_at)` with states `pending|object_deleted|failed`. Verify ownership, insert a pending recovery row, delete the object, mark `object_deleted`, then delete invoice rows and recovery row in one database transaction. If object deletion fails, keep the invoice and mark recovery failed. If database deletion fails after object deletion, retain `object_deleted` so the retry path removes remaining metadata. Return `DELETE_INCOMPLETE` until both sides finish. The UI requires explicit confirmation with seller, date and amount, and displays success only after a 204 response.

```ts
export async function deleteInvoice({ userId, invoiceId }: { userId: string; invoiceId: string }) {
  const invoice = await requireOwnedInvoice(userId, invoiceId);
  const recovery = await createDeletionRecovery(invoice);
  try { await objectStore.delete(invoice.storageKey); }
  catch (error) { await failDeletionRecovery(recovery.id, safeErrorCode(error)); throw appError("DELETE_INCOMPLETE"); }
  await markObjectDeleted(recovery.id);
  await deleteInvoiceMetadataAndRecovery({ userId, invoiceId, recoveryId: recovery.id });
}
```

Run: `pnpm db:generate -- --name deletion_recoveries`

- [ ] **Step 4: 运行跨浏览器与移动端验收**

```ts
test("filters, updates and deletes an invoice", async ({ page }) => {
  await loginAsTestUser(page);
  await page.goto("/invoices?month=2026-08");
  await page.getByLabel("选择发票 i1").check();
  await page.getByRole("button", { name: "标记为已报销" }).click();
  await expect(page.getByText("已报销")).toBeVisible();
  await page.getByRole("button", { name: "删除发票 i1" }).click();
  await page.getByRole("button", { name: "确认永久删除" }).click();
  await expect(page.getByText("发票已删除")).toBeVisible();
});
```

Run: `pnpm playwright test e2e/management-dashboard.spec.ts --project=chromium --project=webkit`

Expected: desktop and mobile projects PASS。

- [ ] **Step 5: 全量验证并提交**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm playwright test e2e/management-dashboard.spec.ts && pnpm build`

```bash
git add src e2e drizzle package.json pnpm-lock.yaml
git commit -m "feat: complete invoice management dashboard"
```

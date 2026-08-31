# Task 3 Report: SQLite schema、迁移与完整性检查

日期：2026-08-31

## 实现

- 新增 `src/lib/db/client.ts`：提供 `openDatabase(file)` 与 `checkDatabase(db)`，启动时开启 `WAL`、`foreign_keys`、`busy_timeout=5000`。
- 新增 `src/lib/db/migrations.ts`：提供 v1 schema 迁移、`BEGIN IMMEDIATE` 事务封装、旧 schema 升级前备份到 `pre-migration-<timestamp>.sqlite`。
- 新增 `src/lib/db/schema.ts`：用 Drizzle 定义 `settings`、`source_files`、`recognition_jobs`、`invoice_drafts`、`invoices`、`duplicate_matches`、`export_jobs`、`status_events`、`deletion_recoveries`、`local_jobs`。
- 新增 `src/lib/db/types.ts`：定义 `LocalDatabase` 与健康检查返回类型。
- 新增 `tests/lib/db/client.test.ts` 与 `tests/lib/db/migrations.test.ts`：全部使用真实临时 SQLite 文件，不 mock 数据库。
- 更新 `package.json` / `pnpm-lock.yaml`：锁定 `better-sqlite3@13.0.3`、`drizzle-orm@0.45.2`、`@types/better-sqlite3@9.6.0`。

## RED 证据

- 先写测试，再执行 `pnpm vitest run tests/lib/db/client.test.ts`。
- 初次结果失败，原因是 `@/lib/db/client` 不存在：
  - `Error: Cannot find package '@/lib/db/client' imported from tests/lib/db/client.test.ts`
- 这证明测试先于实现，且失败点是缺失功能，不是断言拼写问题。

## GREEN 证据

- 落最小实现后，先跑 focused tests：`pnpm vitest run tests/lib/db`
- 中途暴露一处实现 bug：
  - `TypeError: db.sqlite.transaction(...).immediate(...) is not a function`
- 修正为 `const tx = db.sqlite.transaction(fn); tx.immediate(...)` 后复跑。
- focused tests 转绿：
  - `Test Files 2 passed (2)`
  - `Tests 5 passed (5)`

## 完整验证

- `pnpm typecheck`：通过
- `pnpm lint`：通过
- `pnpm test`：通过，`Test Files 6 passed (6)`，`Tests 21 passed (21)`
- `pnpm build`：通过，Next.js 静态页面成功产出

## 文件

- `package.json`
- `pnpm-lock.yaml`
- `src/lib/db/client.ts`
- `src/lib/db/migrations.ts`
- `src/lib/db/schema.ts`
- `src/lib/db/types.ts`
- `tests/lib/db/client.test.ts`
- `tests/lib/db/migrations.test.ts`

## 自审

- 所有金额字段均为 `INTEGER` cents，测试覆盖了 `128000` cents 的精确保留。
- 所有状态字段使用 SQLite `CHECK` 约束；`local_jobs.kind` 也做了枚举约束。
- 迁移幂等：已验证重复调用不会重复写入 `schema_migrations`。
- 外键在打开数据库时强制开启，健康检查会显式报出 `foreign_keys` 被关闭的情况。
- 升级前备份只在已存在 `schema_migrations` 的旧库上触发；首次建库不会生成备份文件。

## 担忧

- `better-sqlite3.backup()` 是异步 Promise API，因此 `migrateDatabase` 设计成“fresh path 同步、升级 path 可 await”。对应地，`openDatabase()` 遇到需要异步备份的旧库会抛出 `DATABASE_REQUIRES_ASYNC_MIGRATION`，避免调用方在迁移未完成时误用连接。后续接入层需要显式处理这条升级路径。

## Fix round 1

### 审查问题

- `openDatabase()` 在旧库路径上看到异步迁移后提前关闭连接，导致 `backup()` Promise 期间连接失效。
- 公开接口 `openDatabase(file)` 对旧 schema 不返回可用数据库，而是抛 `DATABASE_REQUIRES_ASYNC_MIGRATION`。
- 升级测试绕过了公开启动路径，直接构造 `LocalDatabase` 再调用 `migrateDatabase()`。
- 备份测试只匹配文件名，没有验证备份库本身可打开且保留升级前数据。

### RED 证据

先新增公开入口回归测试，再单独执行：

```bash
pnpm vitest run tests/lib/db/client.test.ts -t "upgrades a legacy database through the public openDatabase API and preserves a readable backup"
```

关键失败输出：

```text
FAIL  tests/lib/db/client.test.ts > upgrades a legacy database through the public openDatabase API and preserves a readable backup
Error: DATABASE_REQUIRES_ASYNC_MIGRATION

Unhandled Rejection
TypeError: The database connection is not open
```

这说明公开入口既没有等待旧库升级完成，也让备份在连接提前关闭后直接失败。

### 修复

- 将 `openDatabase(file)` 改成 `Promise<LocalDatabase>`，在返回前统一 `await migrateDatabase(db)`。
- `openDatabase()` 仅在捕获到迁移失败时关闭连接并向上抛错，移除旧的 `DATABASE_REQUIRES_ASYNC_MIGRATION` 路径。
- 将 `migrateDatabase(db)` 改成一致的 `Promise<void>`，旧库路径先 `await backupDatabase(db)`，再执行 `BEGIN IMMEDIATE` 迁移事务。
- 全部数据库测试改为 `await openDatabase(...)`，不再绕过公开启动路径。
- 备份测试新增真实只读 SQLite 校验，确认备份中的 `schema_migrations.version = 0` 且 sentinel 行 `legacy_notes(note-1)` 仍存在。

### GREEN 证据

修复后先跑 focused tests：

```bash
pnpm vitest run tests/lib/db
```

输出：

```text
Test Files  2 passed (2)
Tests  6 passed (6)
```

### 完整验证命令与输出

```bash
pnpm typecheck
git diff --check
pnpm verify
```

关键输出：

```text
pnpm typecheck
> tsc --noEmit

git diff --check
(no output)

pnpm verify
> pnpm lint && pnpm typecheck && pnpm test && pnpm build
Test Files  6 passed (6)
Tests  22 passed (22)
✓ Compiled successfully
```

### 本轮文件

- `src/lib/db/client.ts`
- `src/lib/db/migrations.ts`
- `tests/lib/db/client.test.ts`
- `tests/lib/db/migrations.test.ts`
- `.superpowers/sdd/2026-08-31-invoice-workbench-foundation/task-3-report.md`

### 本轮自审

- 旧库经公开 `await openDatabase()` 现在会返回可用、健康的数据库连接。
- 升级前备份仍落在 `<workRoot>/backups`，首次建库仍不会生成备份文件。
- 测试现在覆盖公开升级入口、备份文件可读性和升级前数据保留，而不只是文件名存在。

### 本轮担忧

- 这轮修复把异步边界前移到了数据库打开阶段；后续任何 RuntimeContext 或服务接入都必须显式 `await openDatabase()`，否则会在类型层面直接报错。

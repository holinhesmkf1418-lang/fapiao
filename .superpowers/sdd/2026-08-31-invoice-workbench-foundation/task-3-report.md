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

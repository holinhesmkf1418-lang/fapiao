# 本地发票工作台基础设施 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可双击启动、仅监听本机、使用 SQLite 和本地文件目录的发票工作台骨架。

**Architecture:** 单个 Next.js 进程同时提供响应式网页、Route Handler API 和进程内任务队列。启动器把运行配置保存在 macOS Application Support，把业务数据库与文件保存在用户工作目录；所有高风险 API 使用每次启动生成的令牌。

**Tech Stack:** Node.js 24、pnpm 9.15、Next.js 16、React 19、TypeScript 5、SQLite/better-sqlite3、Drizzle ORM、Zod、Vitest、Testing Library、Playwright

**Spec:** `docs/product-design.md`

## Global Constraints

- 首版只支持单台 Mac、单个个人用户，不实现登录、远程访问、云同步或多人协作。
- 本地服务只绑定 `127.0.0.1`；默认端口 `4876`，冲突时只尝试 `4877—4885`。
- 默认工作目录为 `~/Documents/发票工作台/`；引导配置位于 `~/Library/Application Support/发票工作台/`。
- SQLite 开启 WAL、外键和 busy timeout；金额一律使用整数分。
- 日志不得包含 OCR 原文、发票图片、绝对来源路径、启动令牌或密钥，并自动保留 7 天。
- 禁止分析、遥测和自动更新网络请求。
- 每个 Task 完成并通过验证后必须独立 `git commit`，随后 `git push origin HEAD`。

---

## File Structure

```text
package.json                         # 依赖、构建与验证命令
next.config.ts                       # standalone 构建和安全响应头
src/app/                             # 页面、布局与本地 API
src/components/app-shell.tsx         # 响应式桌面/窄屏导航
src/lib/bootstrap/paths.ts            # macOS 引导目录与工作目录解析
src/lib/bootstrap/config.ts           # config.json/runtime.json 原子读写
src/lib/db/client.ts                  # SQLite 连接、pragma 与迁移入口
src/lib/db/schema.ts                  # Drizzle 表结构
src/lib/db/migrations.ts              # 版本化 SQL 迁移
src/lib/jobs/queue.ts                 # 并发 2 的可恢复进程内队列
src/lib/security/request-token.ts     # Origin 与启动令牌校验
src/lib/logging/logger.ts             # 结构化脱敏日志
scripts/install.mjs                   # 首次安装流程
scripts/start.mjs                     # 端口选择、服务启动与浏览器打开
scripts/stop.mjs                      # 正常关闭当前实例
首次安装.command                       # Finder 双击入口
启动发票工作台.command                 # Finder 双击入口
关闭发票工作台.command                 # Finder 双击入口
tests/                               # Vitest 与 Playwright 验收测试
```

## Shared Interfaces

```ts
export type BootstrapConfig = { version: 1; workRoot: string; lastPort: number };
export type RuntimeInfo = { pid: number; port: number; token: string; startedAt: string };
export type WorkPaths = { root: string; data: string; invoices: string; exports: string; backups: string; logs: string };
export type LocalDatabase = { sqlite: import("better-sqlite3").Database; close(): void };
export type JobKind = "recognition" | "export" | "maintenance";
export type NewJob = { kind: JobKind; payload: Record<string, unknown> };
export interface LocalJobQueue { enqueue(input: NewJob): Promise<string>; start(): void; stop(): Promise<void>; recover(): Promise<void> }
export type RuntimeContext = { config: BootstrapConfig; runtime: RuntimeInfo; paths: WorkPaths; db: LocalDatabase; queue: LocalJobQueue };
export type LocalLogEvent = { event: string; internalId?: string; stage?: string; errorCode?: string; timestamp?: string };
export interface LocalLogger { info(event: LocalLogEvent): void; warn(event: LocalLogEvent): void; error(event: LocalLogEvent): void }
```

### Task 1: 初始化可测试的本地 Next.js 应用

**Files:**
- Create: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.nvmrc`
- Create: `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Create: `src/components/app-shell.tsx`
- Test: `tests/components/app-shell.test.tsx`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `AppShell({ children, activePath }: { children: ReactNode; activePath: string }): JSX.Element`
- Produces: scripts `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:e2e`, `verify`

- [ ] **Step 1: Write the failing shell test**

```tsx
import { render, screen } from "@testing-library/react";
import { AppShell } from "@/components/app-shell";

it("renders the four local workbench destinations", () => {
  render(<AppShell activePath="/"><div>内容</div></AppShell>);
  for (const name of ["总览", "上传发票", "发票管理", "整理导出"]) {
    expect(screen.getAllByRole("link", { name })[0]).toBeInTheDocument();
  }
  expect(screen.getByText("仅保存在这台 Mac")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and capture the expected failure**

Run: `pnpm vitest run tests/components/app-shell.test.tsx`

Expected: FAIL because `@/components/app-shell` does not exist.

- [ ] **Step 3: Create the pinned toolchain and minimal shell**

Use exact runtime floors and script names in `package.json`:

```json
{
  "name": "invoice-workbench",
  "private": true,
  "packageManager": "pnpm@9.15.9",
  "engines": { "node": ">=22.12 <27" },
  "scripts": {
    "dev": "next dev -H 127.0.0.1",
    "build": "next build",
    "start": "next start -H 127.0.0.1",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "verify": "pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  }
}
```

Implement the four routes `/`, `/upload`, `/invoices`, `/exports`; use an aside above 760px and a bottom nav at or below 760px. Set `output: "standalone"` and `poweredByHeader: false`.

- [ ] **Step 4: Install and run the fast verification set**

Run: `pnpm install --frozen-lockfile=false && pnpm lint && pnpm typecheck && pnpm vitest run tests/components/app-shell.test.tsx && pnpm build`

Expected: all commands exit 0 and `.next/` is produced.

- [ ] **Step 5: Commit and push the application shell**

```bash
git add .gitignore .nvmrc package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.ts tsconfig.json eslint.config.mjs vitest.config.ts playwright.config.ts src tests/components/app-shell.test.tsx
git commit -m "feat: initialize local invoice workbench"
git push origin HEAD
```

### Task 2: 引导配置与安全工作目录

**Files:**
- Create: `src/lib/bootstrap/types.ts`, `src/lib/bootstrap/paths.ts`, `src/lib/bootstrap/config.ts`
- Create: `src/lib/fs/atomic-write.ts`
- Create: `src/lib/logging/logger.ts`
- Test: `tests/lib/bootstrap/config.test.ts`, `tests/lib/bootstrap/paths.test.ts`, `tests/lib/logging/logger.test.ts`

**Interfaces:**
- Produces: `resolveBootstrapDir(home: string): string`
- Produces: `resolveDefaultWorkRoot(home: string): string`
- Produces: `assertInsideWorkRoot(workRoot: string, candidate: string): string`
- Produces: `readBootstrapConfig(dir: string): Promise<BootstrapConfig | null>`
- Produces: `writeBootstrapConfig(dir: string, value: BootstrapConfig): Promise<void>`
- Produces: `ensureWorkRoot(root: string): Promise<WorkPaths>`
- Produces: `createLogger(logDir: string): LocalLogger` accepting only `{ event, internalId?, stage?, errorCode? }`

- [ ] **Step 1: Write failing path and config tests**

```ts
it("uses Documents and rejects traversal", () => {
  expect(resolveDefaultWorkRoot("/Users/test")).toBe("/Users/test/Documents/发票工作台");
  expect(() => assertInsideWorkRoot("/tmp/work", "/tmp/work/../secret"))
    .toThrow("PATH_OUTSIDE_WORK_ROOT");
});

it("round-trips a versioned config atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invoice-config-"));
  const value = { version: 1 as const, workRoot: "/tmp/invoices", lastPort: 4876 };
  await writeBootstrapConfig(dir, value);
  await expect(readBootstrapConfig(dir)).resolves.toEqual(value);
});

it("rejects sensitive and unregistered log fields", async () => {
  const logger = createLogger(logDir);
  expect(() => logger.info({ event: "job_failed", ocrText: "票面内容" } as never))
    .toThrow("UNSAFE_LOG_FIELD");
});
```

- [ ] **Step 2: Verify the tests fail for missing modules**

Run: `pnpm vitest run tests/lib/bootstrap`

Expected: FAIL with module resolution errors for `bootstrap/paths` and `bootstrap/config`.

- [ ] **Step 3: Implement exact types, path containment, and atomic writes**

```ts
export type BootstrapConfig = { version: 1; workRoot: string; lastPort: number };
export type RuntimeInfo = { pid: number; port: number; token: string; startedAt: string };
export type WorkPaths = {
  root: string; data: string; invoices: string; exports: string; backups: string; logs: string;
};
```

Validate JSON with Zod, write to a sibling `.tmp`, `chmod(0o600)`, then rename atomically. Resolve existing parents with `realpath` and reject an absolute escape or a `path.relative` result beginning with `..`. The logger writes one JSON object per line and rejects every key except `event`, `internalId`, `stage`, `errorCode`, `timestamp`; it never accepts arbitrary messages or error stacks.

- [ ] **Step 4: Run focused tests and type checking**

Run: `pnpm vitest run tests/lib/bootstrap tests/lib/logging && pnpm typecheck`

Expected: PASS, including mode `0600` and missing-work-root cases.

- [ ] **Step 5: Commit and push bootstrap storage**

```bash
git add src/lib/bootstrap src/lib/fs src/lib/logging tests/lib/bootstrap tests/lib/logging
git commit -m "feat: add secure local workspace configuration"
git push origin HEAD
```

### Task 3: SQLite schema、迁移与完整性检查

**Files:**
- Create: `src/lib/db/schema.ts`, `src/lib/db/client.ts`, `src/lib/db/migrations.ts`, `src/lib/db/types.ts`
- Test: `tests/lib/db/client.test.ts`, `tests/lib/db/migrations.test.ts`

**Interfaces:**
- Produces: `openDatabase(file: string): LocalDatabase`
- Produces: `migrateDatabase(db: LocalDatabase): void`
- Produces: `checkDatabase(db: LocalDatabase): { ok: boolean; detail: string }`
- Produces tables: `settings`, `source_files`, `recognition_jobs`, `invoice_drafts`, `invoices`, `duplicate_matches`, `export_jobs`, `status_events`, `deletion_recoveries`

- [ ] **Step 1: Write the failing lifecycle test**

```ts
it("opens a WAL database with foreign keys and migrates once", () => {
  const db = openDatabase(join(tempDir, "workbench.sqlite"));
  expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.sqlite.prepare("select version from schema_migrations").get()).toEqual({ version: 1 });
  expect(checkDatabase(db)).toEqual({ ok: true, detail: "ok" });
  db.close();
});
```

- [ ] **Step 2: Confirm the database test fails**

Run: `pnpm vitest run tests/lib/db`

Expected: FAIL because `openDatabase` is not defined.

- [ ] **Step 3: Implement schema version 1 and database ownership**

Define string IDs, ISO timestamps, integer-cent amounts, and checks for `draft|confirmed`, `pending|reimbursing|reimbursed`, and `queued|running|succeeded|failed`. Set:

```ts
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
```

Run migrations in `BEGIN IMMEDIATE`. Before any future schema upgrade, use the SQLite backup API to create `backups/pre-migration-<timestamp>.sqlite`.

- [ ] **Step 4: Verify schema, constraints, and cents**

Run: `pnpm vitest run tests/lib/db && pnpm typecheck`

Expected: PASS, including rejection of an invalid reimbursement status and exact storage of `128000` cents.

- [ ] **Step 5: Commit and push local persistence**

```bash
git add src/lib/db tests/lib/db package.json pnpm-lock.yaml
git commit -m "feat: add sqlite persistence foundation"
git push origin HEAD
```

### Task 4: 可恢复进程内任务队列

**Files:**
- Create: `src/lib/jobs/types.ts`, `src/lib/jobs/queue.ts`, `src/lib/jobs/registry.ts`
- Test: `tests/lib/jobs/queue.test.ts`

**Interfaces:**
- Produces: `JobKind = "recognition" | "export" | "maintenance"`
- Produces: `LocalJobQueue({ concurrency: 2, store, handlers })`
- Produces: `enqueue(input: NewJob): Promise<string>`, `start(): void`, `stop(): Promise<void>`, `recover(): Promise<void>`

- [ ] **Step 1: Write failing concurrency and recovery tests**

```ts
it("runs at most two jobs and requeues interrupted work", async () => {
  const harness = createQueueHarness({ concurrency: 2 });
  await harness.store.seedRunning("old-job");
  await harness.queue.recover();
  await Promise.all([1, 2, 3].map((n) => harness.queue.enqueue({ kind: "maintenance", payload: { n } })));
  await harness.waitForIdle();
  expect(harness.maxActive).toBe(2);
  expect(await harness.store.status("old-job")).toBe("succeeded");
});
```

- [ ] **Step 2: Run and observe the missing queue failure**

Run: `pnpm vitest run tests/lib/jobs/queue.test.ts`

Expected: FAIL because queue modules are absent.

- [ ] **Step 3: Implement persisted FIFO state transitions**

Use an `AbortController` per active job and one `drain()` loop. Persist `queued → running → succeeded|failed` before notifying listeners. On startup convert stale `running` rows to `queued`; on shutdown stop intake and await active promises.

- [ ] **Step 4: Verify concurrency, recovery, and graceful stop**

Run: `pnpm vitest run tests/lib/jobs/queue.test.ts && pnpm typecheck`

Expected: PASS with maximum active count 2 and no stale `running` row after recovery.

- [ ] **Step 5: Commit and push the queue**

```bash
git add src/lib/jobs tests/lib/jobs
git commit -m "feat: add recoverable local job queue"
git push origin HEAD
```

### Task 5: 启动令牌、健康检查与本地应用上下文

**Files:**
- Create: `src/lib/security/request-token.ts`, `src/lib/runtime/context.ts`
- Create: `src/app/api/health/route.ts`, `src/app/api/session/route.ts`, `src/proxy.ts`
- Test: `tests/lib/security/request-token.test.ts`, `tests/app/api/health.test.ts`

**Interfaces:**
- Produces: `requireLocalMutation(request: Request, runtime: RuntimeInfo): void`
- Produces: `getRuntimeContext(): RuntimeContext`
- Produces: `GET /api/health -> { status: "ok"; version: string }`
- Produces: `POST /api/session` exchanges the launch fragment token for an HttpOnly SameSite=Strict cookie

- [ ] **Step 1: Write failing request-security tests**

```ts
it("accepts loopback same-origin requests with the current token only", () => {
  const runtime = { pid: 1, port: 4876, token: "secret", startedAt: "2026-08-31T00:00:00Z" };
  expect(() => requireLocalMutation(request("http://127.0.0.1:4876", "secret"), runtime)).not.toThrow();
  expect(() => requireLocalMutation(request("https://evil.example", "secret"), runtime)).toThrow("INVALID_ORIGIN");
  expect(() => requireLocalMutation(request("http://127.0.0.1:4876", "wrong"), runtime)).toThrow("INVALID_SESSION");
});
```

- [ ] **Step 2: Confirm focused tests fail**

Run: `pnpm vitest run tests/lib/security tests/app/api/health.test.ts`

Expected: FAIL because the security and health modules are absent.

- [ ] **Step 3: Implement fragment exchange and singleton context**

Generate 32 random bytes per launch. Open `http://127.0.0.1:<port>/#launch=<base64url>` so the secret is not sent in the HTTP request; client JavaScript posts the fragment once and calls `history.replaceState`. Store an HMAC digest in the HttpOnly cookie and validate mutation origins against the runtime port.

- [ ] **Step 4: Run security and route tests**

Run: `pnpm vitest run tests/lib/security tests/app/api && pnpm typecheck`

Expected: PASS; invalid origins and tokens receive 403 and tests never print the token.

- [ ] **Step 5: Commit and push API protection**

```bash
git add src/lib/security src/lib/runtime src/app/api src/proxy.ts tests/lib/security tests/app/api
git commit -m "feat: secure local workbench api"
git push origin HEAD
```

### Task 6: Finder 双击安装、启动与关闭

**Files:**
- Create: `scripts/install.mjs`, `scripts/start.mjs`, `scripts/stop.mjs`
- Create: `scripts/lib/process.mjs`, `scripts/lib/macos.mjs`
- Create: `首次安装.command`, `启动发票工作台.command`, `关闭发票工作台.command`
- Create: `tests/scripts/start.test.ts`, `tests/scripts/process.test.ts`
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `findAvailablePort(host, first, last): Promise<number>`
- Produces: `isRecordedProcessAlive(runtime): Promise<boolean>`
- Produces: `chooseWorkRoot(defaultPath): Promise<string>` using `osascript`
- Produces: `pnpm local:install`, `pnpm local:start`, `pnpm local:stop`

- [ ] **Step 1: Write failing launcher tests**

```ts
it("skips occupied ports and reuses a healthy recorded process", async () => {
  const occupied = await listenOn("127.0.0.1", 4876);
  await expect(findAvailablePort("127.0.0.1", 4876, 4885)).resolves.toBe(4877);
  await occupied.close();
  await expect(decideStart({ pidAlive: true, healthOk: true })).resolves.toEqual({ action: "open-existing" });
});
```

- [ ] **Step 2: Run launcher tests and verify failure**

Run: `pnpm vitest run tests/scripts`

Expected: FAIL because launcher helpers are missing.

- [ ] **Step 3: Implement deterministic install/start/stop behavior**

The `.command` files resolve their own directory, invoke the matching Node script, show a Chinese error, and wait for Return only on failure. `start.mjs` validates the work root, chooses `4876—4885`, writes `runtime.json` mode 0600, starts `next start -H 127.0.0.1 -p <port>`, polls `/api/health`, then runs `open` with the fragment token. `stop.mjs` verifies PID ownership and health before SIGTERM; it never kills an unrelated PID.

- [ ] **Step 4: Verify launchers and production build**

Run: `pnpm vitest run tests/scripts && pnpm verify && node scripts/start.mjs --dry-run`

Expected: PASS; dry run reports a loopback address and work root without starting a process.

- [ ] **Step 5: Manual Finder smoke test**

Double-click `首次安装.command`, then `启动发票工作台.command` twice, then `关闭发票工作台.command`.

Expected: first start opens the browser; second start reuses the same PID; close makes `/api/health` unreachable.

- [ ] **Step 6: Commit and push the launchers**

```bash
git add package.json pnpm-lock.yaml scripts *.command README.md tests/scripts
git commit -m "feat: add double-click local launcher"
git push origin HEAD
```

### Task 7: 基础阶段端到端门禁

**Files:**
- Create: `tests/e2e/local-shell.spec.ts`, `tests/fixtures/runtime.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: launcher, health route, session exchange, four-route shell
- Produces: `pnpm test:e2e --grep @foundation`

- [ ] **Step 1: Write the failing foundation journey**

```ts
test("@foundation launches a protected responsive workbench", async ({ page }) => {
  await page.goto(launchUrl);
  await expect(page.getByRole("heading", { name: "发票工作台" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "底部导航" })).toBeVisible();
  expect(await requestFromForeignOrigin("/api/session")).toBe(403);
});
```

- [ ] **Step 2: Run the journey and record the first failure**

Run: `pnpm test:e2e --grep @foundation`

Expected: FAIL until the fixture launches with a valid fragment token.

- [ ] **Step 3: Connect the fixture to an isolated temp work root**

Start on an ephemeral allowed port, set `INVOICE_WORKBENCH_TEST_ROOT`, capture the runtime token without printing it, and tear down the exact child PID after the suite.

- [ ] **Step 4: Run the complete foundation gate**

Run: `pnpm verify && pnpm test:e2e --grep @foundation && git diff --check`

Expected: every command exits 0.

- [ ] **Step 5: Commit and push the foundation gate**

```bash
git add tests/e2e tests/fixtures README.md
git commit -m "test: cover local workbench foundation"
git push origin HEAD
```

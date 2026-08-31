# Task 2 Report

## 实现内容

- 新增 `src/lib/bootstrap/types.ts`，定义 `BootstrapConfig`、`RuntimeInfo`、`WorkPaths`。
- 新增 `src/lib/bootstrap/paths.ts`，提供 bootstrap 目录/默认工作目录解析、`assertInsideWorkRoot` 路径约束、`ensureWorkRoot` 目录创建。
- 新增 `src/lib/fs/atomic-write.ts`，采用 sibling `.tmp`、`chmod(0600)`、`rename` 的原子写入。
- 新增 `src/lib/bootstrap/config.ts`，用 `zod@4.5.4` 校验 `bootstrap.json`，支持缺失返回 `null`、非法 JSON/结构抛出 `INVALID_BOOTSTRAP_CONFIG`。
- 新增 `src/lib/logging/logger.ts`，只接受 `event/internalId/stage/errorCode`，自动补 `timestamp`，按 JSONL 写入 `app.log`，拒绝未注册字段和包含路径/换行的值。
- 新增 `tests/lib/bootstrap/*.test.ts` 与 `tests/lib/logging/logger.test.ts`，覆盖默认路径、`..`/绝对逃逸/现有符号链接逃逸、缺失配置、原子 round-trip、`0600`、非法配置、日志白名单。

## RED 命令与关键输出

```bash
pnpm vitest run tests/lib/bootstrap tests/lib/logging
```

关键输出：

- `Cannot find package '@/lib/bootstrap/config'`
- `Cannot find package '@/lib/bootstrap/paths'`
- `Cannot find package '@/lib/logging/logger'`
- `Test Files 3 failed (3)`

## GREEN 命令与关键输出

```bash
pnpm vitest run tests/lib/bootstrap tests/lib/logging && pnpm typecheck
```

关键输出：

- `Test Files 3 passed (3)`
- `Tests 9 passed (9)`
- `tsc --noEmit` 退出码 `0`

## 完整验证

```bash
pnpm verify
```

关键输出：

- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- `Test Files 4 passed (4)`
- `Tests 11 passed (11)`
- `next build` 成功，`Compiled successfully`

## 修改文件

- `package.json`
- `pnpm-lock.yaml`
- `src/lib/bootstrap/types.ts`
- `src/lib/bootstrap/paths.ts`
- `src/lib/bootstrap/config.ts`
- `src/lib/fs/atomic-write.ts`
- `src/lib/logging/logger.ts`
- `tests/lib/bootstrap/paths.test.ts`
- `tests/lib/bootstrap/config.test.ts`
- `tests/lib/logging/logger.test.ts`
- `.superpowers/sdd/2026-08-31-invoice-workbench-foundation/task-2-report.md`

## 自审

- `assertInsideWorkRoot` 先做规范化相对路径检查，再结合现有父目录的 `realpath` 防止既有符号链接把子路径带出工作根。
- `ensureWorkRoot` 仅创建 brief 要求的五个目录，没有提前实现数据库、队列、启动器相关内容。
- logger 没有接受任意 message 或 stack，避免把 HOME、源码绝对路径或 OCR 文本等敏感内容写入日志。
- 配置写入始终通过原子替换，测试校验了 round-trip 与文件权限 `0600`。

## 担忧

- 当前路径检查按 macOS/Unix 路径语义实现；这是符合本任务的本地 Mac 场景，但没有扩展到 Windows 路径分隔符。

## Fix round 1

### 修复内容

- `src/lib/bootstrap/config.ts` 改为使用产品设计要求的 `config.json` 和 `runtime.json`，补齐 `readRuntimeInfo` / `writeRuntimeInfo`，两类文件都通过 Zod 校验、原子写入并保持 `0600`。
- `src/lib/bootstrap/paths.ts` 把最近存在祖先的 symlink 校验前移到 `mkdir` 之前，避免不安全 root 先落到 symlink target。
- `src/lib/logging/logger.ts` 把字段值从“少量黑名单”改成“机器标识符模式”校验：`event`/`stage` 仅允许短小 lowercase snake id，`internalId` 仅允许短 id 或 UUID，`errorCode` 仅允许 uppercase code；生成的 `timestamp` 也校验 ISO-8601。

### 覆盖测试

- `tests/lib/bootstrap/config.test.ts`
  - `round-trips config.json atomically with mode 0600`
  - `returns null when runtime.json does not exist`
  - `round-trips runtime.json atomically with mode 0600`
  - `rejects invalid runtime config payloads`
- `tests/lib/bootstrap/paths.test.ts`
  - `rejects a work root whose ancestor is a symlink without creating target directories`
- `tests/lib/logging/logger.test.ts`
  - `rejects secret-looking and OCR-like field values`

### RED 命令与关键输出

```bash
pnpm vitest run tests/lib/bootstrap/config.test.ts tests/lib/bootstrap/paths.test.ts tests/lib/logging/logger.test.ts
```

关键输出：

- `ENOENT ... config.json`
- `promise resolved "null" instead of rejecting`
- `TypeError: readRuntimeInfo is not a function`
- `promise resolved "{ ... }" instead of rejecting`
- `expected [Function] to throw an error`

### GREEN / 验证命令与关键输出

```bash
pnpm vitest run tests/lib/bootstrap/config.test.ts tests/lib/bootstrap/paths.test.ts tests/lib/logging/logger.test.ts
pnpm typecheck
pnpm verify
git diff --check
```

关键输出：

- `Test Files 3 passed (3)`
- `Tests 14 passed (14)`
- `Test Files 4 passed (4)`
- `Tests 16 passed (16)`
- `Compiled successfully`
- `git diff --check` 无输出

### 本轮修改文件

- `src/lib/bootstrap/config.ts`
- `src/lib/bootstrap/paths.ts`
- `src/lib/logging/logger.ts`
- `tests/lib/bootstrap/config.test.ts`
- `tests/lib/bootstrap/paths.test.ts`
- `tests/lib/logging/logger.test.ts`

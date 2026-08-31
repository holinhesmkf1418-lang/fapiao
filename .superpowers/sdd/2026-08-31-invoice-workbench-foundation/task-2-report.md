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

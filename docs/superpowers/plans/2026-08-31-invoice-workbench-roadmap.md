# 本地发票工作台实施路线图

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按四个可独立验收阶段，把已确认的本地版产品设计实现为可双击启动的个人发票工作台。

**Architecture:** 以单进程 Next.js、本地 SQLite/文件目录和 Swift 原生助手为核心；默认识别链路完全离线，腾讯云 OCR 只作为单张发票的手动二次确认兜底。阶段之间只通过已经定义并测试的接口衔接。

**Tech Stack:** Node.js 24、pnpm 9.15、Next.js 16、React 19、TypeScript、SQLite/Drizzle、Swift 6/Vision/PDFKit/Security.framework、Vitest、Playwright

**Spec:** `docs/product-design.md`

## Global Constraints

- 从 `main` 当前提交创建新的本地版工作树；不得基于旧 `feat/foundation` 的未完成云端脚手架继续开发。
- 每个详细计划中的 Task 是最小评审与提交单元；通过该 Task 的测试后立即提交并推送。
- 不把真实发票、OCR 原文、云端密钥、启动令牌、绝对来源路径或私有样本加入 Git。
- 不增加登录、远程数据库、对象存储、远程队列、云部署、遥测或自动更新。
- 阶段门禁失败时先修复当前阶段，不带失败进入下一阶段。

---

## 阶段顺序

| 顺序 | 详细计划 | 独立可验收结果 |
| --- | --- | --- |
| 1 | `2026-08-31-invoice-workbench-foundation.md` | 双击安装/启动/关闭；仅监听本机；SQLite、工作目录、令牌和任务队列可用 |
| 2 | `2026-08-31-invoice-workbench-ingestion.md` | 支持五种格式上传、本地 OCR、查重、校对入库和手动云端兜底 |
| 3 | `2026-08-31-invoice-workbench-management-dashboard.md` | 支持查询、三态报销管理、统计图表、原件预览和可恢复删除 |
| 4 | `2026-08-31-invoice-workbench-export.md` | 支持规范 Excel/ZIP、自动/完整备份恢复、维护和最终闭环验收 |

## 执行门禁

- [ ] **Gate 0: 创建干净隔离工作树**

Required skill: `superpowers:using-git-worktrees`.

Expected: 新工作树 HEAD 等于 `origin/main`，`git status --short` 为空，旧 `.worktrees/foundation` 不被修改。

- [ ] **Gate 1: 基础设施完成**

Run: `pnpm verify && pnpm test:e2e --grep @foundation`

Expected: 构建通过；重复启动复用同一 PID；监听地址仅为 `127.0.0.1`。

- [ ] **Gate 2: 上传识别完成**

Run: `swift test --package-path native/InvoiceNative && pnpm verify && pnpm test:e2e --grep @ingestion`

Expected: 本地链路在禁止外网的测试中通过；只有二次确认测试会调用模拟云端适配器。

- [ ] **Gate 3: 管理统计完成**

Run: `pnpm verify && pnpm test:e2e --grep '@management|@dashboard'`

Expected: 明细、状态桶、类型桶和总金额全部按整数分对账；删除失败保留恢复证据。

- [ ] **Gate 4: 导出备份与发布完成**

Run: `pnpm verify:release`

Expected: Excel/ZIP 与快照对账，备份哈希验证通过，完整本地闭环无非回环网络请求。

## 产品设计覆盖矩阵

| 产品设计要求 | 实施位置 |
| --- | --- |
| 双击启动、回环监听、端口回退 | 基础 Task 5–7 |
| 工作目录、引导配置、SQLite/WAL | 基础 Task 2–3 |
| 进程内并发 2、崩溃恢复 | 基础 Task 4 |
| PDF/OFD/JPG/JPEG/PNG、本地 OCR | 上传识别 Task 1–4 |
| 文件级/业务级重复和人工校对 | 上传识别 Task 2、5、7 |
| 腾讯云手动二次确认兜底、钥匙串 | 上传识别 Task 1、6、7 |
| 查询、三态报销、状态历史 | 管理统计 Task 1–4 |
| 月份/类型/金额/状态图表与比例 | 管理统计 Task 3、5 |
| 可恢复删除与启动重试 | 管理统计 Task 6 |
| 文件命名、月份/类型目录、Excel/ZIP | 导出备份 Task 1–5 |
| 每日 7 份备份、完整备份与恢复 | 导出备份 Task 6–7 |
| 日志轮换、磁盘空间、发布验收 | 导出备份 Task 4、6、8 |

## 技术依据

- Apple Vision 的识别能力在实现时以本机 Swift SDK 编译测试为准，不引入外部 OCR 运行时。
- 腾讯云手动兜底使用官方 `RecognizeGeneralInvoice`（API 版本 `2018-11-19`，域名 `ocr.tencentcloudapi.com`），支持图片、PDF 和 OFD；实现时仍以固定响应 fixture 测试，不在 CI 调用真实付费接口。
- 云端供应商通过 `CloudOcrProvider` 接口隔离，核心草稿、查重和确认流程不依赖腾讯字段结构。

## 提交与推送规则

每个 Task 的最后一步必须按计划列出的文件精确暂存，并依次执行：

```bash
git diff --check
git status --short
git commit -m "<计划指定的信息>"
git push origin HEAD
```

不得使用 `git add .` 把私有样本、运行数据、数据库、日志、导出包或密钥意外加入提交。每个阶段结束后在 GitHub 核对远程分支 SHA 与本地 HEAD 一致。

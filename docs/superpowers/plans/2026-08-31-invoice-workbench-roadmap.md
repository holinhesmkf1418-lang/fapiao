# 发票工作台实施路线图

**目标：** 按四个可独立验收的阶段交付个人发票工作台，最终覆盖上传、识别、查重、校对、管理、统计和导出闭环。

**产品设计：** `docs/product-design.md`

## 技术基线

- Node.js：`>=22.12 <27`，开发机当前为 `24.12.0`。
- 包管理器：pnpm `9.15.9`。
- Web：Next.js 16 App Router、React 19.2、TypeScript 5。
- 数据库：PostgreSQL 16、Drizzle ORM、`pg`。
- 认证：Better Auth，邮箱密码登录，数据库会话。
- 异步任务：pg-boss，共用 PostgreSQL，不增加 Redis。
- 文件存储：S3 兼容对象存储，开发和测试使用内存适配器。
- OCR：统一 `OcrProvider` 接口；生产适配腾讯云 `RecognizeGeneralInvoice`，测试使用固定响应适配器。
- 导出：ExcelJS、Archiver。
- 图表：Recharts。
- 测试：Vitest、Testing Library、Playwright；数据库集成测试使用独立 `DATABASE_URL_TEST`。

## 阶段顺序

1. [`2026-08-31-invoice-workbench-foundation.md`](./2026-08-31-invoice-workbench-foundation.md)
   - 可运行的 Next.js 应用、数据库、认证、对象存储边界、应用外壳和 CI。
   - 完成后可以登录并进入受保护的空工作台。
2. [`2026-08-31-invoice-workbench-ingestion.md`](./2026-08-31-invoice-workbench-ingestion.md)
   - 批量上传、文件查重、OCR 队列、腾讯云适配、业务查重和人工校对入库。
   - 完成后可以把真实发票变成已确认的结构化记录。
3. [`2026-08-31-invoice-workbench-management-dashboard.md`](./2026-08-31-invoice-workbench-management-dashboard.md)
   - 发票列表、筛选、状态管理、统计接口、图表、删除和响应式体验。
   - 完成后可以日常管理与查看报销进度。
4. [`2026-08-31-invoice-workbench-export.md`](./2026-08-31-invoice-workbench-export.md)
   - 导出预检、文件命名、Excel、ZIP、异步生成、限时下载、清理与端到端验收。
   - 完成后达到产品设计中的完整 MVP 验收标准。

## 阶段门禁

- 每个阶段独立创建分支并按计划中的小任务提交。
- 进入下一阶段前，必须通过 `pnpm lint`、`pnpm typecheck`、`pnpm test`；有端到端测试的阶段还需通过对应 Playwright 用例。
- 所有数据库变更必须同时提交 Drizzle schema 与生成的 SQL migration。
- 真实云端凭证只能通过环境变量提供，不能写入仓库、测试快照或日志。
- OCR 供应商响应只能通过适配层进入业务代码，页面和数据库查询不得直接依赖腾讯云字段名。
- 金额使用 PostgreSQL `numeric(14,2)` 与字符串边界类型，禁止使用 JavaScript 浮点数累计财务金额。

## 产品设计覆盖矩阵

| 产品设计要求 | 实施位置 |
| --- | --- |
| 个人账号、数据隔离、响应式外壳 | 基础设施 Task 3、4、6 |
| 多格式批量上传、20 MB/100 个限制 | 上传识别 Task 1、2、8 |
| 文件指纹与业务重复检测 | 上传识别 Task 3、7 |
| 云端 OCR、OFD/多票种、失败重试、人工录入 | 上传识别 Task 4、5、6、8 |
| 低置信度校对与关键字段门禁 | 上传识别 Task 7、8 |
| 发票查询、筛选、批量报销状态 | 管理统计 Task 1、2、4 |
| 月份、类型、金额、状态统计与比例图 | 管理统计 Task 3、5 |
| 原始发票安全删除 | 管理统计 Task 6 |
| 命名、月份/类型目录、Excel 与 ZIP | 整理导出 Task 1—6 |
| 限时下载、24 小时清理、重试 | 整理导出 Task 5、7 |
| 浏览器、移动端、2 秒响应、安全与 95% OCR 验收 | 整理导出 Task 7 |

## 官方依据

- Next.js 16 要求 Node.js 20.9+，支持现代 Chrome、Edge 与 Safari：<https://nextjs.org/docs/app/getting-started/installation>
- Better Auth 提供 Next.js、PostgreSQL、Drizzle 与邮箱密码登录集成：<https://better-auth.com/docs/installation>
- pg-boss 使用 PostgreSQL 提供带重试的后台任务，并要求 Node.js 22.12+：<https://github.com/timgit/pg-boss>
- 腾讯云通用票据识别支持多页 PDF、OFD 和常见报销票种：<https://cloud.tencent.com/document/api/866/90802>
- Playwright 覆盖 Chromium、WebKit、Firefox 与移动设备模拟：<https://playwright.dev/docs/intro>

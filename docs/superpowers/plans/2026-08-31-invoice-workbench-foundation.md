# 发票工作台基础设施 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可登录、受保护、可连接 PostgreSQL 与对象存储的响应式空工作台，为识别、统计和导出阶段提供稳定边界。

**Architecture:** 使用 Next.js 16 App Router 作为同仓 Web 与 API 应用；PostgreSQL 保存认证和业务数据，Drizzle 管理 schema 与 migration。Better Auth 提供邮箱密码会话，对象存储通过 `ObjectStore` 接口隔离生产 S3 与测试内存实现。

**Tech Stack:** Node.js 24、pnpm 9、Next.js 16、React 19.2、TypeScript 5、PostgreSQL 16、Drizzle ORM、Better Auth、AWS SDK v3、Zod、Vitest、Testing Library

**Spec:** `docs/product-design.md`

## Global Constraints

- Node.js 必须满足 `>=22.12 <27`；pnpm 固定为 `9.15.9`。
- 页面使用中文，桌面端与手机端都必须可完成核心操作。
- 密钥、数据库地址和存储凭证只能来自环境变量，不得提交真实值。
- 金额在数据库中使用 `numeric(14,2)`，应用边界使用十进制字符串。
- 用户所有权校验放在服务端，不接受客户端传入的用户 ID 作为授权依据。
- 每个行为变更先写失败测试，再写最小实现。

---

### Task 1: 初始化可测试的 Next.js 应用

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.nvmrc`
- Create: `.gitignore`
- Create: `next.config.ts`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `vitest.config.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Create: `src/app/page.test.tsx`

**Interfaces:**
- Consumes: 无。
- Produces: `pnpm dev`、`pnpm build`、`pnpm lint`、`pnpm typecheck`、`pnpm test`；别名 `@/* -> src/*`。

- [ ] **Step 1: 写应用入口失败测试**

```tsx
// src/app/page.test.tsx
import { render, screen } from "@testing-library/react";
import HomePage from "./page";

test("shows the product name", () => {
  render(<HomePage />);
  expect(screen.getByRole("heading", { name: "发票工作台" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 创建测试配置并验证测试失败**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

```ts
// src/test/setup.ts
import "@testing-library/jest-dom/vitest";
```

Run: `pnpm test -- src/app/page.test.tsx`

Expected: FAIL，因为 `src/app/page.tsx` 尚不存在。

- [ ] **Step 3: 创建最小应用与依赖清单**

```json
{
  "name": "invoice-workbench",
  "private": true,
  "packageManager": "pnpm@9.15.9",
  "engines": { "node": ">=22.12 <27" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "latest",
    "@aws-sdk/s3-request-presigner": "latest",
    "better-auth": "latest",
    "drizzle-orm": "latest",
    "next": "^16.0.0",
    "pg": "latest",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "zod": "latest"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "latest",
    "@testing-library/react": "latest",
    "@types/node": "latest",
    "@types/pg": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "@vitejs/plugin-react": "latest",
    "drizzle-kit": "latest",
    "eslint": "latest",
    "eslint-config-next": "^16.0.0",
    "jsdom": "latest",
    "typescript": "^5.1.0",
    "vitest": "latest"
  }
}
```

```tsx
// src/app/page.tsx
export default function HomePage() {
  return <main><h1>发票工作台</h1><p>上传、识别、管理并导出个人发票。</p></main>;
}
```

```tsx
// src/app/layout.tsx
import "./globals.css";

export const metadata = { title: "发票工作台", description: "个人发票整理工具" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - "."
```

```text
# .nvmrc
24
```

```ts
// next.config.ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = { output: "standalone" };
export default nextConfig;
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "types": ["vitest/globals", "node"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

```js
// eslint.config.mjs
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
export default defineConfig([...nextVitals, ...nextTs, globalIgnores([".next/**", "coverage/**"])]);
```

```text
# .gitignore
node_modules/
.next/
coverage/
test-results/
playwright-report/
.env*
!.env.example
*.log
```

```css
/* src/app/globals.css */
* { box-sizing: border-box; }
html { color-scheme: light dark; }
body { margin: 0; font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: light-dark(#f6f8fc, #0e1421); color: light-dark(#172033, #ecf2ff); }
:focus-visible { outline: 3px solid #3769ee; outline-offset: 2px; }
```

Do not copy the prototype's fixed demo height into production pages.

Run: `pnpm install`

- [ ] **Step 4: 运行基础质量检查**

Run: `pnpm test -- src/app/page.test.tsx && pnpm lint && pnpm typecheck && pnpm build`

Expected: 全部 PASS，生产构建生成成功。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml .nvmrc .gitignore next.config.ts tsconfig.json eslint.config.mjs vitest.config.ts src
git commit -m "chore: scaffold invoice workbench"
```

---

### Task 2: 环境变量与启动校验

**Files:**
- Create: `.env.example`
- Create: `src/config/env.ts`
- Create: `src/config/env.test.ts`

**Interfaces:**
- Consumes: `process.env`。
- Produces: `getServerEnv(input?: NodeJS.ProcessEnv): ServerEnv`，包含 `DATABASE_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、S3 与腾讯云配置。

- [ ] **Step 1: 写环境解析失败测试**

```ts
import { describe, expect, test } from "vitest";
import { getServerEnv } from "./env";

describe("getServerEnv", () => {
  test("rejects a short auth secret", () => {
    expect(() => getServerEnv({ DATABASE_URL: "postgres://localhost/test", BETTER_AUTH_SECRET: "short", BETTER_AUTH_URL: "http://localhost:3000" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  test("accepts disabled external services in tests", () => {
    const env = getServerEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost/test",
      BETTER_AUTH_SECRET: "12345678901234567890123456789012",
      BETTER_AUTH_URL: "http://localhost:3000",
      OBJECT_STORE_DRIVER: "memory",
      OCR_DRIVER: "fake"
    });
    expect(env.OBJECT_STORE_DRIVER).toBe("memory");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/config/env.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现分支校验**

```ts
// src/config/env.ts
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  OBJECT_STORE_DRIVER: z.enum(["memory", "s3"]).default("memory"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  OCR_DRIVER: z.enum(["fake", "tencent"]).default("fake"),
  TENCENT_SECRET_ID: z.string().optional(),
  TENCENT_SECRET_KEY: z.string().optional()
}).superRefine((value, ctx) => {
  if (value.OBJECT_STORE_DRIVER === "s3") {
    for (const key of ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required for s3` });
    }
  }
  if (value.OCR_DRIVER === "tencent") {
    for (const key of ["TENCENT_SECRET_ID", "TENCENT_SECRET_KEY"] as const) {
      if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required for tencent OCR` });
    }
  }
});

export type ServerEnv = z.infer<typeof schema>;
export function getServerEnv(input: NodeJS.ProcessEnv = process.env): ServerEnv { return schema.parse(input); }
```

`.env.example` must list every key with empty or local-safe values and comments, never real credentials.

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/config/env.test.ts && pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add .env.example src/config
git commit -m "feat: validate server environment"
```

---

### Task 3: PostgreSQL、Drizzle 与认证表

**Files:**
- Create: `drizzle.config.ts`
- Create: `src/db/client.ts`
- Create: `src/db/schema/auth.ts`
- Create: `src/db/schema/index.ts`
- Create: `src/db/schema/auth.test.ts`
- Create: `drizzle/0000_auth.sql` (generated)

**Interfaces:**
- Consumes: `getServerEnv().DATABASE_URL`。
- Produces: `db`、`users`、`sessions`、`accounts`、`verifications`，供 Better Auth 和业务表外键使用。

- [ ] **Step 1: 写 schema 约束测试**

```ts
import { getTableConfig } from "drizzle-orm/pg-core";
import { accounts, sessions, users } from "./auth";

test("auth schema has unique email, token and provider account", () => {
  expect(getTableConfig(users).indexes.filter((index) => index.config.unique)).toHaveLength(1);
  expect(getTableConfig(sessions).indexes.filter((index) => index.config.unique)).toHaveLength(1);
  expect(getTableConfig(accounts).indexes.filter((index) => index.config.unique)).toHaveLength(1);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/db/schema/auth.test.ts`

Expected: FAIL，认证表尚不存在。

- [ ] **Step 3: 定义认证表与数据库客户端**

```ts
// src/db/schema/auth.ts
import { boolean, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const users = pgTable("user", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull(),
  emailVerified: boolean("email_verified").default(false).notNull(), image: text("image"), ...timestamps,
}, (table) => [uniqueIndex("user_email_unique").on(table.email)]);

export const sessions = pgTable("session", {
  id: text("id").primaryKey(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull(), ipAddress: text("ip_address"), userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), ...timestamps,
}, (table) => [uniqueIndex("session_token_unique").on(table.token)]);

export const accounts = pgTable("account", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull(), providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"), refreshToken: text("refresh_token"), idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"), password: text("password"), ...timestamps,
}, (table) => [uniqueIndex("account_provider_unique").on(table.providerId, table.accountId)]);

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), ...timestamps,
});
```

`src/db/client.ts` must create a singleton `pg.Pool` in development and export `db = drizzle(pool, { schema })`. `drizzle.config.ts` must use dialect `postgresql`, schema `./src/db/schema/index.ts`, output `./drizzle`, and `DATABASE_URL` from the environment.

- [ ] **Step 4: 生成 migration 并验证**

Run: `pnpm db:generate -- --name auth`

Expected: 在 `drizzle/` 生成包含四张表、外键和三个唯一索引的 SQL。

Run: `pnpm test -- src/db/schema/auth.test.ts && pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add drizzle.config.ts drizzle src/db
git commit -m "feat: add database and auth schema"
```

---

### Task 4: 邮箱密码登录与服务端会话

**Files:**
- Create: `src/lib/auth.ts`
- Create: `src/lib/auth-client.ts`
- Create: `src/lib/session.ts`
- Create: `src/app/api/auth/[...all]/route.ts`
- Create: `src/app/(auth)/login/page.tsx`
- Create: `src/app/(auth)/login/login-form.tsx`
- Create: `src/app/(auth)/login/login-form.test.tsx`
- Create: `src/app/(auth)/register/page.tsx`

**Interfaces:**
- Consumes: `db` 与认证表。
- Produces: `auth`、`authClient`、`requireSession(): Promise<{ user: { id: string; email: string; name: string } }>`。

- [ ] **Step 1: 写登录表单行为测试**

```tsx
test("submits email and password", async () => {
  const signIn = vi.fn().mockResolvedValue({ data: {}, error: null });
  render(<LoginForm signIn={signIn} />);
  await userEvent.type(screen.getByLabelText("邮箱"), "me@example.com");
  await userEvent.type(screen.getByLabelText("密码"), "correct-horse-battery");
  await userEvent.click(screen.getByRole("button", { name: "登录" }));
  expect(signIn).toHaveBeenCalledWith({ email: "me@example.com", password: "correct-horse-battery" });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/app/'(auth)'/login/login-form.test.tsx`

Expected: FAIL，`LoginForm` 不存在。

- [ ] **Step 3: 实现 Better Auth 与登录页面**

```ts
// src/lib/auth.ts
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db/client";
import * as schema from "@/db/schema";
import { accounts, sessions, users, verifications } from "@/db/schema/auth";
import { getServerEnv } from "@/config/env";

const env = getServerEnv();
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { ...schema, user: users, session: sessions, account: accounts, verification: verifications },
  }),
  emailAndPassword: { enabled: true, minPasswordLength: 10 },
});
```

```ts
// src/lib/session.ts
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

export async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return session;
}
```

The API route must export `GET` and `POST` using `toNextJsHandler(auth)`. The client form must expose pending and error states, use `autocomplete="email"` and `autocomplete="current-password"`, and redirect to `/dashboard` only after a successful response.

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/app/'(auth)'/login/login-form.test.tsx && pnpm typecheck && pnpm build`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib src/app/api src/app/'(auth)'
git commit -m "feat: add email password authentication"
```

---

### Task 5: 对象存储抽象与 S3 实现

**Files:**
- Create: `src/storage/object-store.ts`
- Create: `src/storage/memory-object-store.ts`
- Create: `src/storage/s3-object-store.ts`
- Create: `src/storage/index.ts`
- Create: `src/storage/object-store.test.ts`

**Interfaces:**
- Consumes: S3 环境配置。
- Produces: `ObjectStore`：`put`、`getStream`、`delete`、`signedDownloadUrl`；`getObjectStore(): ObjectStore`。

- [ ] **Step 1: 写对象存储契约测试**

```ts
import { Readable } from "node:stream";
import { MemoryObjectStore } from "./memory-object-store";

test("stores, reads and deletes a private object", async () => {
  const store = new MemoryObjectStore();
  await store.put({ key: "users/u1/a.pdf", body: Buffer.from("invoice"), contentType: "application/pdf" });
  expect(await streamToBuffer(await store.getStream("users/u1/a.pdf"))).toEqual(Buffer.from("invoice"));
  await store.delete("users/u1/a.pdf");
  await expect(store.getStream("users/u1/a.pdf")).rejects.toThrow("OBJECT_NOT_FOUND");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/storage/object-store.test.ts`

Expected: FAIL，内存实现不存在。

- [ ] **Step 3: 实现统一接口和两个适配器**

```ts
// src/storage/object-store.ts
import type { Readable } from "node:stream";

export interface ObjectStore {
  put(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  signedDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
}
```

`S3ObjectStore` must use `PutObjectCommand`、`GetObjectCommand`、`DeleteObjectCommand` and `getSignedUrl`. It must never set public ACLs. `getObjectStore()` selects the adapter only from validated `OBJECT_STORE_DRIVER`.

```ts
async put(input: { key: string; body: Buffer; contentType: string }) {
  await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: input.key, Body: input.body, ContentType: input.contentType }));
}

async signedDownloadUrl(key: string, expiresInSeconds: number) {
  return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds });
}
```

- [ ] **Step 4: 验证**

Run: `pnpm test -- src/storage/object-store.test.ts && pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/storage
git commit -m "feat: add private object storage boundary"
```

---

### Task 6: 受保护的响应式应用外壳

**Files:**
- Create: `src/app/(workbench)/layout.tsx`
- Create: `src/app/(workbench)/dashboard/page.tsx`
- Create: `src/components/workbench-shell.tsx`
- Create: `src/components/workbench-shell.module.css`
- Create: `src/components/workbench-shell.test.tsx`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `requireSession()`。
- Produces: `/dashboard` 受保护路由；桌面左侧导航和移动底部导航。

- [ ] **Step 1: 写导航可访问性测试**

```tsx
test("shows the four primary destinations", () => {
  render(<WorkbenchShell userName="老孙"><div>内容</div></WorkbenchShell>);
  for (const name of ["总览", "上传发票", "发票管理", "整理导出"]) {
    expect(screen.getByRole("link", { name })).toBeInTheDocument();
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- src/components/workbench-shell.test.tsx`

Expected: FAIL，组件不存在。

- [ ] **Step 3: 实现外壳**

Use semantic `<nav aria-label="主要导航">` and these exact routes: `/dashboard`、`/upload`、`/invoices`、`/exports`. CSS breakpoint at `760px`: left navigation above the breakpoint, fixed bottom navigation at or below it. The protected layout calls `requireSession()` and passes `session.user.name` to the shell. Root `/` redirects to `/dashboard`.

```tsx
const links = [
  ["/dashboard", "总览"], ["/upload", "上传发票"], ["/invoices", "发票管理"], ["/exports", "整理导出"],
] as const;

export function WorkbenchShell({ userName, children }: { userName: string; children: React.ReactNode }) {
  return <div className={styles.shell}>
    <aside className={styles.sidebar}><strong>发票工作台</strong><nav aria-label="主要导航">{links.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}</nav></aside>
    <main className={styles.content}><span className={styles.userName}>{userName}</span>{children}</main>
    <nav className={styles.mobileNav} aria-label="主要导航">{links.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}</nav>
  </div>;
}
```

- [ ] **Step 4: 验证响应式与构建**

Run: `pnpm test -- src/components/workbench-shell.test.tsx && pnpm lint && pnpm typecheck && pnpm build`

Expected: PASS；无横向溢出规则，键盘焦点可见。

- [ ] **Step 5: 提交**

```bash
git add src/app src/components
git commit -m "feat: add protected responsive workbench shell"
```

---

### Task 7: CI 与本地启动说明

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Create: `scripts/wait-for-postgres.mjs`

**Interfaces:**
- Consumes: GitHub Actions PostgreSQL 16 service。
- Produces: 每次推送执行 install、migration、lint、typecheck、unit test、build。

- [ ] **Step 1: 写 CI 脚本 smoke test**

Create `scripts/wait-for-postgres.mjs` using `pg.Pool` to retry `select 1` for at most 30 seconds and exit non-zero after timeout.

```js
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1000 });
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try { await pool.query("select 1"); await pool.end(); process.exit(0); }
  catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
}
console.error("PostgreSQL unavailable");
await pool.end().catch(() => undefined);
process.exit(1);
```

Run: `DATABASE_URL='postgres://invalid:invalid@127.0.0.1:1/none' node scripts/wait-for-postgres.mjs`

Expected: 30 秒内以非零状态退出并打印 `PostgreSQL unavailable`，不得打印连接密码。

- [ ] **Step 2: 创建 CI**

CI must use `actions/checkout`、`pnpm/action-setup` with `9.15.9`、`actions/setup-node` with Node 24 and pnpm cache, plus PostgreSQL 16 service. Set test-only secrets inline in workflow, then run:

```yaml
- run: pnpm install --frozen-lockfile
- run: node scripts/wait-for-postgres.mjs
- run: pnpm db:migrate
- run: pnpm lint
- run: pnpm typecheck
- run: pnpm test
- run: pnpm build
```

- [ ] **Step 3: 编写本地说明**

README must include exact commands `pnpm install`、copy `.env.example` to `.env.local`、create PostgreSQL database、`pnpm db:migrate`、`pnpm dev`; explain that secrets stay local and that no Docker is required.

- [ ] **Step 4: 全量验证**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add .github README.md scripts
git commit -m "ci: verify foundation and document setup"
```

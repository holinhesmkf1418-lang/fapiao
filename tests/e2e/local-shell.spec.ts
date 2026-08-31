import { expect, test } from "@playwright/test";
import {
  launchFoundationRuntime,
  type FoundationRuntime,
} from "../fixtures/runtime";

let runtime: FoundationRuntime;

test.beforeAll(async () => {
  runtime = await launchFoundationRuntime();
});

test.afterAll(async () => {
  await runtime?.stop();
});

test("@foundation launches a protected responsive workbench", async ({
  context,
  page,
  request,
}) => {
  await page.goto(runtime.launchUrl);

  await expect(page.getByRole("heading", { name: "发票工作台" })).toBeVisible();
  await expect.poll(() => page.url()).not.toContain("launch=");
  await expect
    .poll(async () =>
      (await context.cookies()).some(
        (cookie) => cookie.name === "invoice_workbench_session" && cookie.httpOnly,
      ),
    )
    .toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "底部导航" })).toBeVisible();

  const foreignResponse = await request.post(`${runtime.baseUrl}/api/session`, {
    data: { token: "invalid" },
    headers: { Origin: "https://example.invalid" },
  });
  expect(foreignResponse.status()).toBe(403);
});

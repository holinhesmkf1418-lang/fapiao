/* @vitest-environment node */

import { expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

it("returns a non-cacheable local health response", async () => {
  const response = await GET();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: "ok", version: "0.1.0" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

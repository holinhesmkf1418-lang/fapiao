import { expect, it } from "vitest";
import { proxy } from "@/proxy";

it("adds browser hardening headers", () => {
  const response = proxy();

  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
});

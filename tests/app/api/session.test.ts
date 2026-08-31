/* @vitest-environment node */

import { expect, it } from "vitest";
import { createSessionResponse } from "@/app/api/session/route";
import type { RuntimeInfo } from "@/lib/bootstrap/types";

const runtime: RuntimeInfo = {
  pid: 1,
  port: 4876,
  token: "secret",
  startedAt: "2026-08-31T00:00:00.000Z",
};

it("exchanges the launch token for an HttpOnly strict cookie without echoing it", async () => {
  const response = await createSessionResponse(sessionRequest("secret"), runtime);
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toMatch(/invoice_workbench_session=.*HttpOnly.*SameSite=Strict/i);
  expect(body).not.toContain(runtime.token);
  expect(body).toBe('{"status":"ok"}');
});

it("rejects a foreign origin and an incorrect token without setting a cookie", async () => {
  const foreign = await createSessionResponse(sessionRequest("secret", "https://evil.example"), runtime);
  const wrong = await createSessionResponse(sessionRequest("wrong"), runtime);

  expect(foreign.status).toBe(403);
  expect(wrong.status).toBe(403);
  expect(foreign.headers.get("set-cookie")).toBeNull();
  expect(wrong.headers.get("set-cookie")).toBeNull();
});

function sessionRequest(token: string, origin = "http://127.0.0.1:4876"): Request {
  return new Request("http://127.0.0.1:4876/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token }),
  });
}

/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import {
  createSessionCookieValue,
  requireLaunchToken,
  requireLocalMutation,
  SESSION_COOKIE_NAME,
} from "@/lib/security/request-token";
import type { RuntimeInfo } from "@/lib/bootstrap/types";

const runtime: RuntimeInfo = {
  pid: 1,
  port: 4876,
  token: "secret",
  startedAt: "2026-08-31T00:00:00.000Z",
};

describe("local request security", () => {
  it("accepts only the exact loopback origin with the derived session cookie", () => {
    const cookie = createSessionCookieValue(runtime.token);
    const request = mutationRequest("http://127.0.0.1:4876", cookie);

    expect(() => requireLocalMutation(request, runtime)).not.toThrow();
    expect(cookie).not.toBe(runtime.token);
  });

  it("rejects a foreign origin before considering its cookie", () => {
    const request = mutationRequest(
      "https://evil.example",
      createSessionCookieValue(runtime.token),
    );

    expect(() => requireLocalMutation(request, runtime)).toThrow("INVALID_ORIGIN");
  });

  it("rejects a raw launch token or a cookie derived from another token", () => {
    expect(() => requireLocalMutation(mutationRequest("http://127.0.0.1:4876", "secret"), runtime))
      .toThrow("INVALID_SESSION");
    expect(() => requireLocalMutation(
      mutationRequest("http://127.0.0.1:4876", createSessionCookieValue("wrong")),
      runtime,
    )).toThrow("INVALID_SESSION");
  });

  it("compares the one-time launch token exactly", () => {
    expect(() => requireLaunchToken("secret", runtime)).not.toThrow();
    expect(() => requireLaunchToken("wrong", runtime)).toThrow("INVALID_SESSION");
  });
});

function mutationRequest(origin: string, cookieValue: string): Request {
  return new Request("http://127.0.0.1:4876/api/example", {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${cookieValue}`,
      origin,
    },
  });
}

import { createHmac, timingSafeEqual } from "node:crypto";
import type { RuntimeInfo } from "@/lib/bootstrap/types";

export const SESSION_COOKIE_NAME = "invoice_workbench_session";

const SESSION_CONTEXT = "invoice-workbench-session-v1";

function valuesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function expectedOrigin(runtime: RuntimeInfo): string {
  return `http://127.0.0.1:${runtime.port}`;
}

function readCookie(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator === -1) continue;

    const cookieName = cookie.slice(0, separator).trim();
    if (cookieName === name) return cookie.slice(separator + 1).trim();
  }

  return undefined;
}

export function createSessionCookieValue(token: string): string {
  return createHmac("sha256", token).update(SESSION_CONTEXT).digest("base64url");
}

export function requireLocalOrigin(request: Request, runtime: RuntimeInfo): void {
  if (request.headers.get("origin") !== expectedOrigin(runtime)) {
    throw new Error("INVALID_ORIGIN");
  }
}

export function requireLaunchToken(token: unknown, runtime: RuntimeInfo): void {
  if (typeof token !== "string" || !valuesMatch(token, runtime.token)) {
    throw new Error("INVALID_SESSION");
  }
}

export function requireLocalMutation(request: Request, runtime: RuntimeInfo): void {
  requireLocalOrigin(request, runtime);

  const actual = readCookie(request, SESSION_COOKIE_NAME);
  const expected = createSessionCookieValue(runtime.token);
  if (actual === undefined || !valuesMatch(actual, expected)) {
    throw new Error("INVALID_SESSION");
  }
}

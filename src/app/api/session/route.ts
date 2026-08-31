import type { RuntimeInfo } from "@/lib/bootstrap/types";
import { getRuntimeContext } from "@/lib/runtime/context";
import {
  createSessionCookieValue,
  requireLaunchToken,
  requireLocalOrigin,
  SESSION_COOKIE_NAME,
} from "@/lib/security/request-token";

function forbidden(): Response {
  return Response.json(
    { error: "FORBIDDEN" },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

export async function createSessionResponse(
  request: Request,
  runtime: RuntimeInfo,
): Promise<Response> {
  try {
    requireLocalOrigin(request, runtime);
    const body: unknown = await request.json();
    const token =
      typeof body === "object" && body !== null && "token" in body
        ? body.token
        : undefined;
    requireLaunchToken(token, runtime);

    return Response.json(
      { status: "ok" },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": `${SESSION_COOKIE_NAME}=${createSessionCookieValue(runtime.token)}; Path=/; HttpOnly; SameSite=Strict`,
        },
      },
    );
  } catch {
    return forbidden();
  }
}

export async function POST(request: Request): Promise<Response> {
  const { runtime } = await getRuntimeContext();
  return createSessionResponse(request, runtime);
}

export function GET(): Response {
  return Response.json(
    { status: "ok", version: "0.1.0" },
    { headers: { "Cache-Control": "no-store" } },
  );
}

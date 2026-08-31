import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionBootstrap } from "@/components/session-bootstrap";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("removes the launch token from the URL before exchanging it", async () => {
  window.history.replaceState(null, "", "/#launch=one-time-secret");
  let hashWhenRequested = "not-called";
  const fetchMock = vi.fn(async () => {
    hashWhenRequested = window.location.hash;
    return Response.json({ status: "ok" });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<SessionBootstrap />);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(hashWhenRequested).toBe("");
  expect(window.location.href).not.toContain("one-time-secret");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/session",
    expect.objectContaining({
      body: JSON.stringify({ token: "one-time-secret" }),
      method: "POST",
    }),
  );
});

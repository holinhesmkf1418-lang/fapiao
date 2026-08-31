/* @vitest-environment node */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLogger } from "@/lib/logging/logger";

const cleanupRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

it("rejects sensitive and unregistered log fields", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "invoice-logs-reject-"));
  cleanupRoots.push(logDir);

  const logger = createLogger(logDir);

  expect(() =>
    logger.info({ event: "job_failed", ocrText: "票面内容" } as never),
  ).toThrowError("UNSAFE_LOG_FIELD");
});

it("rejects secret-looking and OCR-like field values", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "invoice-logs-secret-"));
  cleanupRoots.push(logDir);

  const logger = createLogger(logDir);

  expect(() =>
    logger.error({
      event: "job_failed",
      errorCode: "sk-live-secret-token",
    }),
  ).toThrowError("UNSAFE_LOG_FIELD");
  expect(() =>
    logger.warn({
      event: "job_failed",
      internalId: "票面内容",
    }),
  ).toThrowError("UNSAFE_LOG_FIELD");
  expect(() =>
    logger.info({
      event: "job_failed",
      stage: "bootstrap failed",
    }),
  ).toThrowError("UNSAFE_LOG_FIELD");
});

it("writes newline-delimited json with only approved fields", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "invoice-logs-write-"));
  cleanupRoots.push(logDir);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T08:00:00.000Z"));

  const logger = createLogger(logDir);
  await logger.info({
    event: "job_started",
    internalId: "job-123",
    stage: "bootstrap",
    errorCode: "NONE",
  });

  const contents = await readFile(join(logDir, "app.log"), "utf8");
  const lines = contents.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual({
    timestamp: "2026-08-31T08:00:00.000Z",
    event: "job_started",
    internalId: "job-123",
    stage: "bootstrap",
    errorCode: "NONE",
  });
});

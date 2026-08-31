/* @vitest-environment node */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readBootstrapConfig,
  readRuntimeInfo,
  writeBootstrapConfig,
  writeRuntimeInfo,
} from "@/lib/bootstrap/config";
import type { BootstrapConfig, RuntimeInfo } from "@/lib/bootstrap/types";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

it("returns null when the bootstrap config file does not exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invoice-config-missing-"));
  cleanupRoots.push(dir);

  await expect(readBootstrapConfig(dir)).resolves.toBeNull();
});

it("round-trips config.json atomically with mode 0600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invoice-config-roundtrip-"));
  cleanupRoots.push(dir);

  const value: BootstrapConfig = {
    version: 1,
    workRoot: "/tmp/invoices",
    lastPort: 4876,
  };

  await writeBootstrapConfig(dir, value);

  await expect(readBootstrapConfig(dir)).resolves.toEqual(value);

  const fileStats = await stat(join(dir, "config.json"));
  expect(fileStats.mode & 0o777).toBe(0o600);
});

it("rejects invalid bootstrap config payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invoice-config-invalid-"));
  cleanupRoots.push(dir);

  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({ version: 2, workRoot: "", lastPort: "nope" }),
    "utf8",
  );

  await expect(readBootstrapConfig(dir)).rejects.toThrowError(
    "INVALID_BOOTSTRAP_CONFIG",
  );
});

it("returns null when runtime.json does not exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invoice-runtime-missing-"));
  cleanupRoots.push(dir);

  await expect(readRuntimeInfo(dir)).resolves.toBeNull();
});

it("round-trips runtime.json atomically with mode 0600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invoice-runtime-roundtrip-"));
  cleanupRoots.push(dir);

  const value: RuntimeInfo = {
    pid: 4312,
    port: 4876,
    token: "runtime-token-123",
    startedAt: "2026-08-31T08:00:00.000Z",
  };

  await writeRuntimeInfo(dir, value);

  await expect(readRuntimeInfo(dir)).resolves.toEqual(value);

  const fileStats = await stat(join(dir, "runtime.json"));
  expect(fileStats.mode & 0o777).toBe(0o600);
});

it("rejects invalid runtime config payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invoice-runtime-invalid-"));
  cleanupRoots.push(dir);

  await writeFile(
    join(dir, "runtime.json"),
    JSON.stringify({ pid: "bad", port: -1, token: "", startedAt: "later" }),
    "utf8",
  );

  await expect(readRuntimeInfo(dir)).rejects.toThrowError(
    "INVALID_RUNTIME_INFO",
  );
});

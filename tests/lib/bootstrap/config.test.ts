/* @vitest-environment node */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readBootstrapConfig,
  writeBootstrapConfig,
} from "@/lib/bootstrap/config";
import type { BootstrapConfig } from "@/lib/bootstrap/types";

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

it("round-trips a versioned config atomically with mode 0600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invoice-config-roundtrip-"));
  cleanupRoots.push(dir);

  const value: BootstrapConfig = {
    version: 1,
    workRoot: "/tmp/invoices",
    lastPort: 4876,
  };

  await writeBootstrapConfig(dir, value);

  await expect(readBootstrapConfig(dir)).resolves.toEqual(value);

  const fileStats = await stat(join(dir, "bootstrap.json"));
  expect(fileStats.mode & 0o777).toBe(0o600);
});

it("rejects invalid bootstrap config payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invoice-config-invalid-"));
  cleanupRoots.push(dir);

  await writeFile(
    join(dir, "bootstrap.json"),
    JSON.stringify({ version: 2, workRoot: "", lastPort: "nope" }),
    "utf8",
  );

  await expect(readBootstrapConfig(dir)).rejects.toThrowError(
    "INVALID_BOOTSTRAP_CONFIG",
  );
});

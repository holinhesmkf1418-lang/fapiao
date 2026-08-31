/* @vitest-environment node */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkDatabase, openDatabase } from "@/lib/db/client";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

it("opens a WAL database with foreign keys and migrates once", async () => {
  // Regression guard: a fresh workspace must always boot into a usable SQLite file.
  const tempRoot = await mkdtemp(join(tmpdir(), "invoice-db-client-"));
  cleanupRoots.push(tempRoot);

  const db = openDatabase(join(tempRoot, "workbench.sqlite"));

  expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.sqlite.prepare("select version from schema_migrations").get()).toEqual({
    version: 1,
  });
  expect(checkDatabase(db)).toEqual({ ok: true, detail: "ok" });

  db.close();
});

it("reports a failed health check when foreign keys are disabled after open", async () => {
  // Regression guard: health checks must catch sessions that silently lose FK enforcement.
  const tempRoot = await mkdtemp(join(tmpdir(), "invoice-db-health-"));
  cleanupRoots.push(tempRoot);

  const db = openDatabase(join(tempRoot, "workbench.sqlite"));
  db.sqlite.pragma("foreign_keys = OFF");

  expect(checkDatabase(db)).toEqual({
    ok: false,
    detail: "foreign_keys pragma is disabled",
  });

  db.close();
});

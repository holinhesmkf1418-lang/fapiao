/* @vitest-environment node */

import { access, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertInsideWorkRoot,
  ensureWorkRoot,
  resolveBootstrapDir,
  resolveDefaultWorkRoot,
} from "@/lib/bootstrap/paths";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

it("uses Documents-derived defaults for bootstrap and work root", () => {
  expect(resolveBootstrapDir("/Users/test")).toBe(
    "/Users/test/Library/Application Support/发票工作台",
  );
  expect(resolveDefaultWorkRoot("/Users/test")).toBe(
    "/Users/test/Documents/发票工作台",
  );
});

it("rejects traversal outside the work root", () => {
  expect(() =>
    assertInsideWorkRoot("/tmp/work", "/tmp/work/../secret"),
  ).toThrowError("PATH_OUTSIDE_WORK_ROOT");
});

it("rejects absolute escapes and existing symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "invoice-work-root-"));
  cleanupRoots.push(root);

  await mkdir(join(root, "safe"), { recursive: true });
  await symlink("/tmp", join(root, "safe", "escape"));

  expect(() => assertInsideWorkRoot(root, "/tmp/secret.txt")).toThrowError(
    "PATH_OUTSIDE_WORK_ROOT",
  );
  expect(() =>
    assertInsideWorkRoot(root, join(root, "safe", "escape", "secret.txt")),
  ).toThrowError("PATH_OUTSIDE_WORK_ROOT");
});

it("creates the required workspace directories for a missing work root", async () => {
  const base = await mkdtemp(join(tmpdir(), "invoice-workspace-parent-"));
  const root = join(base, "workspace");
  cleanupRoots.push(base);

  await expect(ensureWorkRoot(root)).resolves.toEqual({
    root,
    data: join(root, "data"),
    invoices: join(root, "invoices"),
    exports: join(root, "exports"),
    backups: join(root, "backups"),
    logs: join(root, "logs"),
  });
});

it("rejects a work root whose ancestor is a symlink without creating target directories", async () => {
  const base = await mkdtemp(join(tmpdir(), "invoice-workspace-symlink-"));
  const target = join(base, "target");
  const link = join(base, "link");
  const unsafeRoot = join(link, "workspace");
  cleanupRoots.push(base);

  await mkdir(target, { recursive: true });
  await symlink(target, link);

  await expect(ensureWorkRoot(unsafeRoot)).rejects.toThrowError(
    "PATH_OUTSIDE_WORK_ROOT",
  );
  await expect(access(join(target, "workspace"))).rejects.toThrow();
});

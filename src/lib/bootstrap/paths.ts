import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { WorkPaths } from "@/lib/bootstrap/types";

const APP_NAME = "发票工作台";
const REQUIRED_DIRECTORIES = [
  "data",
  "invoices",
  "exports",
  "backups",
  "logs",
] as const;

function hasTraversalSegment(input: string): boolean {
  return input.split("/").includes("..");
}

function resolveExistingParent(targetPath: string): {
  resolvedPath: string;
  remainder: string;
} {
  let currentPath = resolve(targetPath);

  while (!existsSync(currentPath)) {
    const parentPath = resolve(currentPath, "..");
    if (parentPath === currentPath) {
      throw new Error("PATH_OUTSIDE_WORK_ROOT");
    }

    currentPath = parentPath;
  }

  const stats = lstatSync(currentPath);
  if (stats.isSymbolicLink()) {
    throw new Error("PATH_OUTSIDE_WORK_ROOT");
  }

  return {
    resolvedPath: realpathSync.native(currentPath),
    remainder: relative(currentPath, resolve(targetPath)),
  };
}

function assertContainedPath(rootPath: string, candidatePath: string): string {
  if (hasTraversalSegment(candidatePath)) {
    throw new Error("PATH_OUTSIDE_WORK_ROOT");
  }

  const relativePath = relative(rootPath, candidatePath);
  if (relativePath.startsWith("..") || relativePath === "..") {
    throw new Error("PATH_OUTSIDE_WORK_ROOT");
  }

  if (relativePath === "" || !relativePath.startsWith("..")) {
    return candidatePath;
  }

  throw new Error("PATH_OUTSIDE_WORK_ROOT");
}

export function resolveBootstrapDir(home: string): string {
  return join(home, "Library", "Application Support", APP_NAME);
}

export function resolveDefaultWorkRoot(home: string): string {
  return join(home, "Documents", APP_NAME);
}

export function assertInsideWorkRoot(workRoot: string, candidate: string): string {
  const absoluteRoot = resolve(workRoot);
  const absoluteCandidate = resolve(candidate);

  assertContainedPath(absoluteRoot, absoluteCandidate);

  const rootParent = resolveExistingParent(absoluteRoot);
  const candidateParent = resolveExistingParent(absoluteCandidate);
  const effectiveRoot = resolve(rootParent.resolvedPath, rootParent.remainder);
  const effectiveCandidate = resolve(
    candidateParent.resolvedPath,
    candidateParent.remainder,
  );

  assertContainedPath(effectiveRoot, effectiveCandidate);
  return absoluteCandidate;
}

export async function ensureWorkRoot(root: string): Promise<WorkPaths> {
  if (hasTraversalSegment(root)) {
    throw new Error("PATH_OUTSIDE_WORK_ROOT");
  }

  const absoluteRoot = resolve(root);
  resolveExistingParent(absoluteRoot);
  mkdirSync(absoluteRoot, { recursive: true });

  const paths = {
    root: absoluteRoot,
    data: join(absoluteRoot, "data"),
    invoices: join(absoluteRoot, "invoices"),
    exports: join(absoluteRoot, "exports"),
    backups: join(absoluteRoot, "backups"),
    logs: join(absoluteRoot, "logs"),
  } satisfies WorkPaths;

  for (const directory of REQUIRED_DIRECTORIES) {
    const target = join(absoluteRoot, directory);
    assertInsideWorkRoot(absoluteRoot, target);
    mkdirSync(target, { recursive: true });
  }

  return paths;
}

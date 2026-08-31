import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeBootstrapConfig,
  writeRuntimeInfo,
} from "@/lib/bootstrap/config";
import { createRuntimeContext } from "@/lib/runtime/context";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("createRuntimeContext", () => {
  it("opens the configured local workspace and database", async () => {
    const root = await mkdtemp(join(tmpdir(), "invoice-runtime-"));
    temporaryDirectories.push(root);
    const bootstrapDir = join(root, "bootstrap");
    const workRoot = join(root, "workspace");

    await writeBootstrapConfig(bootstrapDir, {
      version: 1,
      workRoot,
      lastPort: 4876,
    });
    await writeRuntimeInfo(bootstrapDir, {
      pid: 1,
      port: 4876,
      token: "secret",
      startedAt: "2026-08-31T00:00:00.000Z",
    });

    const context = await createRuntimeContext(bootstrapDir);

    expect(context.paths.root).toBe(workRoot);
    expect(context.database.file).toBe(join(workRoot, "data", "workbench.sqlite"));
    expect(context.runtime.port).toBe(4876);
    context.database.close();
  });
});

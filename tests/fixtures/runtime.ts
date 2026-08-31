import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeBootstrapConfig,
  writeRuntimeInfo,
} from "../../src/lib/bootstrap/config";
import {
  findAvailablePort,
  isPidAlive,
  waitForHealth,
} from "../../scripts/lib/process.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export type FoundationRuntime = {
  baseUrl: string;
  launchUrl: string;
  stop(): Promise<void>;
};

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || !isPidAlive(child.pid)) return;
  child.kill("SIGTERM");

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isPidAlive(child.pid)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  if (isPidAlive(child.pid)) throw new Error("E2E_SERVER_STOP_TIMEOUT");
}

export async function launchFoundationRuntime(): Promise<FoundationRuntime> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "invoice-foundation-"));
  const bootstrapDir = join(temporaryRoot, "bootstrap");
  const workRoot = join(temporaryRoot, "workspace");
  const standaloneRoot = join(projectRoot, ".next", "standalone");
  const serverFile = join(standaloneRoot, "server.js");
  const port = await findAvailablePort("127.0.0.1", 4890, 4990);
  const token = randomBytes(32).toString("base64url");

  await mkdir(join(standaloneRoot, ".next"), { recursive: true });
  await cp(join(projectRoot, ".next", "static"), join(standaloneRoot, ".next", "static"), {
    force: true,
    recursive: true,
  });
  await writeBootstrapConfig(bootstrapDir, {
    version: 1,
    workRoot,
    lastPort: port,
  });

  const child = spawn(process.execPath, [serverFile], {
    cwd: standaloneRoot,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      INVOICE_WORKBENCH_BOOTSTRAP_DIR: bootstrapDir,
      PORT: String(port),
    },
    stdio: "ignore",
  });

  if (!child.pid) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw new Error("E2E_SERVER_START_FAILED");
  }

  await writeRuntimeInfo(bootstrapDir, {
    pid: child.pid,
    port,
    token,
    startedAt: new Date().toISOString(),
  });

  try {
    await waitForHealth(port);
  } catch (error) {
    await stopChild(child);
    await rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    launchUrl: `${baseUrl}/#launch=${encodeURIComponent(token)}`,
    async stop() {
      await stopChild(child);
      await rm(temporaryRoot, { force: true, recursive: true });
    },
  };
}

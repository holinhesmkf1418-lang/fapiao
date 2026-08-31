import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openBrowser } from "./lib/macos.mjs";
import {
  findAvailablePort,
  isPidAlive,
  isRecordedProcessAlive,
  waitForHealth,
} from "./lib/process.mjs";
import {
  readConfig,
  readRuntime,
  removeRuntime,
  resolveBootstrapDir,
  resolveDefaultWorkRoot,
  writeRuntime,
} from "./lib/state.mjs";

const HOST = "127.0.0.1";
const FIRST_PORT = 4876;
const LAST_PORT = 4885;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function decideStart({ healthOk, pidAlive }) {
  return { action: healthOk && pidAlive ? "open-existing" : "start-new" };
}

function launchUrl(runtime) {
  return `http://${HOST}:${runtime.port}/#launch=${encodeURIComponent(runtime.token)}`;
}

export async function startLocal({ dryRun = false, open = true } = {}) {
  const bootstrapDir = resolveBootstrapDir();
  const config = await readConfig(bootstrapDir);
  const workRoot = config?.workRoot || resolveDefaultWorkRoot();
  const serverFile = join(projectRoot, ".next", "standalone", "server.js");
  const recorded = await readRuntime(bootstrapDir);

  if (dryRun) {
    const port = await findAvailablePort(HOST, FIRST_PORT, LAST_PORT);
    console.log(`本地地址：http://${HOST}:${port}`);
    console.log(`工作目录：${workRoot}`);
    return { action: "dry-run", port, workRoot };
  }

  if (!config) throw new Error("请先双击“首次安装.command”");
  if (!existsSync(serverFile)) throw new Error("尚未完成生产构建，请重新运行首次安装");

  const recordedAlive = await isRecordedProcessAlive(recorded, serverFile);
  const decision = decideStart({
    healthOk: recordedAlive,
    pidAlive: recorded ? isPidAlive(recorded.pid) : false,
  });
  if (decision.action === "open-existing") {
    if (open) await openBrowser(launchUrl(recorded));
    return { action: "open-existing", pid: recorded.pid, port: recorded.port };
  }

  await removeRuntime(bootstrapDir);
  mkdirSync(join(workRoot, "logs"), { recursive: true });
  const port = await findAvailablePort(HOST, FIRST_PORT, LAST_PORT);
  const logFile = openSync(join(workRoot, "logs", "server.log"), "a", 0o600);
  const child = spawn(process.execPath, [serverFile], {
    cwd: dirname(serverFile),
    detached: true,
    env: {
      ...process.env,
      HOSTNAME: HOST,
      INVOICE_WORKBENCH_BOOTSTRAP_DIR: bootstrapDir,
      PORT: String(port),
    },
    stdio: ["ignore", logFile, logFile],
  });
  closeSync(logFile);
  child.unref();
  if (!child.pid) throw new Error("LOCAL_SERVER_START_FAILED");

  const runtime = {
    pid: child.pid,
    port,
    token: randomBytes(32).toString("base64url"),
    startedAt: new Date().toISOString(),
  };
  await writeRuntime(runtime, bootstrapDir);

  try {
    await waitForHealth(port);
  } catch (error) {
    if (isPidAlive(child.pid)) process.kill(child.pid, "SIGTERM");
    await removeRuntime(bootstrapDir);
    throw error;
  }

  if (open) await openBrowser(launchUrl(runtime));
  return { action: "start-new", pid: child.pid, port };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await startLocal({ dryRun });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`启动失败：${error instanceof Error ? error.message : "未知错误"}`);
    process.exitCode = 1;
  });
}

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPidAlive, isRecordedProcessAlive } from "./lib/process.mjs";
import {
  readRuntime,
  removeRuntime,
  resolveBootstrapDir,
} from "./lib/state.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function stopLocal() {
  const bootstrapDir = resolveBootstrapDir();
  const runtime = await readRuntime(bootstrapDir);
  const serverFile = join(projectRoot, ".next", "standalone", "server.js");

  if (!(await isRecordedProcessAlive(runtime, serverFile))) {
    await removeRuntime(bootstrapDir);
    return { action: "already-stopped" };
  }

  process.kill(runtime.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isPidAlive(runtime.pid)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  if (isPidAlive(runtime.pid)) throw new Error("服务未能正常关闭，请稍后重试");
  await removeRuntime(bootstrapDir);
  return { action: "stopped" };
}

async function main() {
  const result = await stopLocal();
  console.log(result.action === "stopped" ? "发票工作台已关闭。" : "发票工作台当前未运行。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`关闭失败：${error instanceof Error ? error.message : "未知错误"}`);
    process.exitCode = 1;
  });
}

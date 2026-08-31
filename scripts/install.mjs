import { spawnSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chooseWorkRoot } from "./lib/macos.mjs";
import { resolveDefaultWorkRoot, writeConfig } from "./lib/state.mjs";
import { startLocal } from "./start.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败`);
}

async function copyStandaloneAssets() {
  const standaloneRoot = join(projectRoot, ".next", "standalone");
  await mkdir(join(standaloneRoot, ".next"), { recursive: true });
  await cp(join(projectRoot, ".next", "static"), join(standaloneRoot, ".next", "static"), {
    force: true,
    recursive: true,
  });

  const publicDirectory = join(projectRoot, "public");
  if (existsSync(publicDirectory)) {
    await cp(publicDirectory, join(standaloneRoot, "public"), {
      force: true,
      recursive: true,
    });
  }
}

export async function installLocal({ useDefault = false } = {}) {
  const defaultWorkRoot = resolveDefaultWorkRoot();
  await mkdir(defaultWorkRoot, { recursive: true });
  const workRoot =
    useDefault || process.platform !== "darwin"
      ? defaultWorkRoot
      : await chooseWorkRoot(defaultWorkRoot);

  await writeConfig({ version: 1, workRoot, lastPort: 4876 });
  run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["build"]);
  await copyStandaloneAssets();
  await startLocal();
}

async function main() {
  console.log("正在安装发票工作台，请稍候……");
  await installLocal({ useDefault: process.argv.includes("--default") });
  console.log("安装完成，工作台已在浏览器中打开。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`安装失败：${error instanceof Error ? error.message : "未知错误"}`);
    process.exitCode = 1;
  });
}

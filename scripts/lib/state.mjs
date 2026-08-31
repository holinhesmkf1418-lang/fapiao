import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const APP_NAME = "发票工作台";

export function resolveBootstrapDir() {
  return join(homedir(), "Library", "Application Support", APP_NAME);
}

export function resolveDefaultWorkRoot() {
  return join(homedir(), "Documents", APP_NAME);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivateJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

export async function readConfig(bootstrapDir = resolveBootstrapDir()) {
  return readJson(join(bootstrapDir, "config.json"));
}

export async function writeConfig(config, bootstrapDir = resolveBootstrapDir()) {
  await writePrivateJson(join(bootstrapDir, "config.json"), config);
}

export async function readRuntime(bootstrapDir = resolveBootstrapDir()) {
  return readJson(join(bootstrapDir, "runtime.json"));
}

export async function writeRuntime(runtime, bootstrapDir = resolveBootstrapDir()) {
  await writePrivateJson(join(bootstrapDir, "runtime.json"), runtime);
}

export async function removeRuntime(bootstrapDir = resolveBootstrapDir()) {
  await rm(join(bootstrapDir, "runtime.json"), { force: true });
}

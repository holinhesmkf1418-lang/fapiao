import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomically } from "@/lib/fs/atomic-write";
import type { BootstrapConfig, RuntimeInfo } from "@/lib/bootstrap/types";

const bootstrapConfigSchema = z.object({
  version: z.literal(1),
  workRoot: z.string().min(1),
  lastPort: z.number().int().min(0),
});

const isoTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
);

const runtimeInfoSchema = z.object({
  pid: z.number().int().min(1),
  port: z.number().int().min(0).max(65535),
  token: z.string().min(1),
  startedAt: isoTimestampSchema,
});

const BOOTSTRAP_CONFIG_FILENAME = "config.json";
const RUNTIME_INFO_FILENAME = "runtime.json";

function parseBootstrapConfig(input: unknown): BootstrapConfig {
  try {
    return bootstrapConfigSchema.parse(input);
  } catch {
    throw new Error("INVALID_BOOTSTRAP_CONFIG");
  }
}

function parseRuntimeInfo(input: unknown): RuntimeInfo {
  try {
    return runtimeInfoSchema.parse(input);
  } catch {
    throw new Error("INVALID_RUNTIME_INFO");
  }
}

async function readValidatedJson<T>(
  filePath: string,
  parseValue: (input: unknown) => T,
  invalidCode: string,
): Promise<T | null> {
  let fileContents: string;

  try {
    fileContents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  try {
    return parseValue(JSON.parse(fileContents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(invalidCode);
    }

    throw error;
  }
}

async function writeValidatedJson<T>(
  filePath: string,
  value: T,
  parseValue: (input: unknown) => T,
): Promise<void> {
  const parsedValue = parseValue(value);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, JSON.stringify(parsedValue, null, 2));
}

export async function readBootstrapConfig(
  dir: string,
): Promise<BootstrapConfig | null> {
  return readValidatedJson(
    join(dir, BOOTSTRAP_CONFIG_FILENAME),
    parseBootstrapConfig,
    "INVALID_BOOTSTRAP_CONFIG",
  );
}

export async function writeBootstrapConfig(
  dir: string,
  value: BootstrapConfig,
): Promise<void> {
  await writeValidatedJson(
    join(dir, BOOTSTRAP_CONFIG_FILENAME),
    value,
    parseBootstrapConfig,
  );
}

export async function readRuntimeInfo(dir: string): Promise<RuntimeInfo | null> {
  return readValidatedJson(
    join(dir, RUNTIME_INFO_FILENAME),
    parseRuntimeInfo,
    "INVALID_RUNTIME_INFO",
  );
}

export async function writeRuntimeInfo(
  dir: string,
  value: RuntimeInfo,
): Promise<void> {
  await writeValidatedJson(join(dir, RUNTIME_INFO_FILENAME), value, parseRuntimeInfo);
}

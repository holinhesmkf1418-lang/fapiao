import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomically } from "@/lib/fs/atomic-write";
import type { BootstrapConfig } from "@/lib/bootstrap/types";

const bootstrapConfigSchema = z.object({
  version: z.literal(1),
  workRoot: z.string().min(1),
  lastPort: z.number().int().min(0),
});

const BOOTSTRAP_CONFIG_FILENAME = "bootstrap.json";

function parseBootstrapConfig(input: unknown): BootstrapConfig {
  try {
    return bootstrapConfigSchema.parse(input);
  } catch {
    throw new Error("INVALID_BOOTSTRAP_CONFIG");
  }
}

export async function readBootstrapConfig(
  dir: string,
): Promise<BootstrapConfig | null> {
  const filePath = join(dir, BOOTSTRAP_CONFIG_FILENAME);

  try {
    const fileContents = await readFile(filePath, "utf8");
    return parseBootstrapConfig(JSON.parse(fileContents));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    if (error instanceof SyntaxError) {
      throw new Error("INVALID_BOOTSTRAP_CONFIG");
    }

    throw error;
  }
}

export async function writeBootstrapConfig(
  dir: string,
  value: BootstrapConfig,
): Promise<void> {
  const filePath = join(dir, BOOTSTRAP_CONFIG_FILENAME);
  const config = parseBootstrapConfig(value);

  await mkdir(dir, { recursive: true });
  await writeFileAtomically(filePath, JSON.stringify(config, null, 2));
}

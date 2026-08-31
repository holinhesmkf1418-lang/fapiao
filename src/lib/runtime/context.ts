import { homedir } from "node:os";
import { join } from "node:path";
import {
  readBootstrapConfig,
  readRuntimeInfo,
} from "@/lib/bootstrap/config";
import { ensureWorkRoot, resolveBootstrapDir } from "@/lib/bootstrap/paths";
import type {
  BootstrapConfig,
  RuntimeInfo,
  WorkPaths,
} from "@/lib/bootstrap/types";
import { openDatabase } from "@/lib/db/client";
import type { LocalDatabase } from "@/lib/db/types";
import { LocalJobQueue } from "@/lib/jobs/queue";
import { createJobHandlerRegistry } from "@/lib/jobs/registry";
import type { JobHandlerRegistry } from "@/lib/jobs/types";

export type RuntimeContext = {
  config: BootstrapConfig;
  database: LocalDatabase;
  handlers: JobHandlerRegistry;
  paths: WorkPaths;
  queue: LocalJobQueue;
  runtime: RuntimeInfo;
};

let contextPromise: Promise<RuntimeContext> | null = null;

export async function createRuntimeContext(
  bootstrapDir: string,
): Promise<RuntimeContext> {
  const [config, runtime] = await Promise.all([
    readBootstrapConfig(bootstrapDir),
    readRuntimeInfo(bootstrapDir),
  ]);

  if (!config) throw new Error("MISSING_BOOTSTRAP_CONFIG");
  if (!runtime) throw new Error("MISSING_RUNTIME_INFO");

  const paths = await ensureWorkRoot(config.workRoot);
  const database = await openDatabase(join(paths.data, "workbench.sqlite"));

  try {
    const handlers = createJobHandlerRegistry();
    const queue = new LocalJobQueue({
      concurrency: 2,
      handlers,
      store: database,
    });
    await queue.recover();

    return { config, database, handlers, paths, queue, runtime };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function getRuntimeContext(): Promise<RuntimeContext> {
  if (!contextPromise) {
    const configuredDir = process.env.INVOICE_WORKBENCH_BOOTSTRAP_DIR?.trim();
    contextPromise = createRuntimeContext(
      configuredDir || resolveBootstrapDir(homedir()),
    );
  }

  return contextPromise;
}

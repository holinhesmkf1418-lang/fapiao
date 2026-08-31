/* @vitest-environment node */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { createJobHandlerRegistry } from "@/lib/jobs/registry";
import { LocalJobQueue } from "@/lib/jobs/queue";
import type { JobErrorMapper, JobHandlerContext, JobKind } from "@/lib/jobs/types";
import type { LocalDatabase } from "@/lib/db/types";

const cleanupRoots: string[] = [];
const cleanupDatabases: LocalDatabase[] = [];

afterEach(async () => {
  for (const db of cleanupDatabases.splice(0)) {
    db.close();
  }
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

it("runs recovered and newly enqueued jobs in FIFO order without exceeding concurrency two", async () => {
  // Regression guard: restart recovery must not leave stale running rows stranded or let the scheduler oversubscribe handlers.
  const harness = await createQueueHarness({ concurrency: 2, kind: "maintenance" });

  await harness.store.seedJob({
    id: "job-0000",
    kind: "maintenance",
    payload: { n: 0 },
    status: "running",
    attemptCount: 1,
    createdAt: "2026-08-31T00:00:00.000Z",
    startedAt: "2026-08-31T00:01:00.000Z",
    finishedAt: null,
    errorCode: null,
  });

  harness.queue.start();
  await harness.queue.recover();

  for (const n of [1, 2, 3]) {
    await harness.queue.enqueue({ kind: "maintenance", payload: { n } });
  }

  await harness.waitFor(() => harness.started.length === 2);
  expect(harness.started).toEqual([0, 1]);
  expect(harness.maxActive).toBe(2);
  expect(await harness.store.status("job-0000")).toBe("running");

  harness.release(0);
  harness.release(1);

  await harness.waitFor(() => harness.started.length === 4);
  expect(harness.started).toEqual([0, 1, 2, 3]);
  expect(harness.maxActive).toBe(2);

  harness.release(2);
  harness.release(3);

  await harness.waitForIdle();

  expect(await harness.store.status("job-0000")).toBe("succeeded");
  expect(await harness.store.statusByPayloadNumber(1)).toBe("succeeded");
  expect(await harness.store.statusByPayloadNumber(2)).toBe("succeeded");
  expect(await harness.store.statusByPayloadNumber(3)).toBe("succeeded");
  expect(await harness.store.countByStatus("queued")).toBe(0);
  expect(await harness.store.countByStatus("running")).toBe(0);
});

it("stops intake, waits for active jobs, and leaves not-yet-started jobs queued", async () => {
  // Regression guard: shutdown must be graceful, never abort in-flight writes, and never silently discard queued work.
  const harness = await createQueueHarness({ concurrency: 2, kind: "maintenance" });

  harness.queue.start();
  for (const n of [1, 2, 3]) {
    await harness.queue.enqueue({ kind: "maintenance", payload: { n } });
  }

  await harness.waitFor(() => harness.started.length === 2);
  expect(harness.started).toEqual([1, 2]);
  expect(harness.signalStates).toEqual([
    { n: 1, abortedAtStart: false },
    { n: 2, abortedAtStart: false },
  ]);

  const stopPromise = harness.queue.stop();

  await expect(
    harness.queue.enqueue({ kind: "maintenance", payload: { n: 4 } }),
  ).rejects.toThrow(/queue has stopped/i);

  harness.release(1);
  harness.release(2);
  await stopPromise;

  expect(harness.completed).toEqual([1, 2]);
  expect(harness.started).toEqual([1, 2]);
  expect(harness.signalStates).toEqual([
    { n: 1, abortedAtStart: false, abortedAfterStop: false },
    { n: 2, abortedAtStart: false, abortedAfterStop: false },
  ]);
  expect(await harness.store.statusByPayloadNumber(1)).toBe("succeeded");
  expect(await harness.store.statusByPayloadNumber(2)).toBe("succeeded");
  expect(await harness.store.statusByPayloadNumber(3)).toBe("queued");
});

it("stores stable error codes instead of arbitrary handler messages", async () => {
  // Regression guard: persistence must capture machine-stable failure codes, not leak raw exception text into durable state.
  const harness = await createQueueHarness({
    concurrency: 2,
    errorCode: "EXPORT_HANDLER_FAILED",
    kind: "export",
    run: async () => {
      throw new Error("raw upstream error: bucket invoices/private.pdf");
    },
  });

  harness.queue.start();
  const jobId = await harness.queue.enqueue({ kind: "export", payload: { n: 9 } });

  await harness.waitForIdle();

  expect(await harness.store.row(jobId)).toEqual({
    attempt_count: 1,
    created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    error_code: "EXPORT_HANDLER_FAILED",
    finished_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    id: jobId,
    kind: "export",
    payload_json: JSON.stringify({ n: 9 }),
    started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    status: "failed",
  });
});

it("falls back to a stable code when an error mapper returns unsafe text", async () => {
  // Regression guard: a buggy handler adapter must not persist a secret or free-text error as an error code.
  const harness = await createQueueHarness({
    concurrency: 2,
    errorCode: "sk-live-secret-token",
    kind: "export",
    run: async () => {
      throw new Error("provider failed");
    },
  });

  harness.queue.start();
  const jobId = await harness.queue.enqueue({ kind: "export", payload: { n: 10 } });
  await harness.waitForIdle();

  expect(await harness.store.row(jobId)).toMatchObject({
    error_code: "JOB_HANDLER_FAILED",
    status: "failed",
  });
});

type QueueHarnessOptions = {
  concurrency: number;
  errorCode?: string;
  kind: JobKind;
  run?: (context: JobHandlerContext<NumberPayload>) => Promise<void>;
};

type NumberPayload = { n: number };

type JobSeed = {
  attemptCount: number;
  createdAt: string;
  errorCode: string | null;
  finishedAt: string | null;
  id: string;
  kind: JobKind;
  payload: NumberPayload;
  startedAt: string | null;
  status: "failed" | "queued" | "running" | "succeeded";
};

async function createQueueHarness(options: QueueHarnessOptions) {
  const tempRoot = await mkdtemp(join(tmpdir(), "invoice-job-queue-"));
  cleanupRoots.push(tempRoot);

  const db = await openDatabase(join(tempRoot, "workbench.sqlite"));
  cleanupDatabases.push(db);
  const gates = new Map<number, PromiseWithResolvers<void>>();
  const started: number[] = [];
  const completed: number[] = [];
  const signalStates: Array<{
    abortedAfterStop?: boolean;
    abortedAtStart: boolean;
    n: number;
  }> = [];
  let active = 0;
  let maxActive = 0;
  const runHandler: (context: JobHandlerContext<NumberPayload>) => Promise<void> =
    options.run ??
    (async ({ payload, signal }) => {
      started.push(payload.n);
      signalStates.push({ n: payload.n, abortedAtStart: signal.aborted });
      active += 1;
      maxActive = Math.max(maxActive, active);

      const gate = gates.get(payload.n) ?? createGate();
      gates.set(payload.n, gate);
      await gate.promise;

      const signalStateIndex = signalStates.findIndex((entry) => entry.n === payload.n);
      signalStates[signalStateIndex] = {
        ...signalStates[signalStateIndex],
        abortedAfterStop: signal.aborted,
      };
      completed.push(payload.n);
      active -= 1;
    });

  const registry = createJobHandlerRegistry();
  registry.register(options.kind, {
    mapError: createErrorMapper(options.errorCode),
    run: runHandler,
  });

  const queue = new LocalJobQueue({
    concurrency: options.concurrency,
    handlers: registry,
    store: db,
  });

  return {
    completed,
    get maxActive() {
      return maxActive;
    },
    queue,
    release(n: number) {
      const gate = gates.get(n);
      if (!gate) {
        throw new Error(`missing gate for ${n}`);
      }
      gate.resolve();
    },
    signalStates,
    started,
    store: createStoreHarness(db),
    async waitFor(predicate: () => boolean): Promise<void> {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for queue state");
        }
        await delay(10);
      }
    },
    async waitForIdle(): Promise<void> {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await countBusyRows(db)) === 0 && active === 0) {
          return;
        }
        await delay(10);
      }
      throw new Error("timed out waiting for queue to go idle");
    },
  };
}

function createStoreHarness(db: LocalDatabase) {
  return {
    async countByStatus(status: string): Promise<number> {
      return (
        db.sqlite
          .prepare<[string], { count: number }>("select count(*) as count from local_jobs where status = ?")
          .get(status)?.count ?? 0
      );
    },
    async row(id: string) {
      return (
        db.sqlite
          .prepare<[string], Record<string, unknown>>("select * from local_jobs where id = ?")
          .get(id) ?? null
      );
    },
    async seedJob(seed: JobSeed): Promise<void> {
      db.sqlite
        .prepare(
          "insert into local_jobs (id, kind, payload_json, status, error_code, attempt_count, created_at, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          seed.id,
          seed.kind,
          JSON.stringify(seed.payload),
          seed.status,
          seed.errorCode,
          seed.attemptCount,
          seed.createdAt,
          seed.startedAt,
          seed.finishedAt,
        );
    },
    async status(id: string): Promise<string | null> {
      return (
        db.sqlite
          .prepare<[string], { status: string }>("select status from local_jobs where id = ?")
          .get(id)?.status ?? null
      );
    },
    async statusByPayloadNumber(n: number): Promise<string | null> {
      return (
        db.sqlite
          .prepare<[string], { status: string }>(
            "select status from local_jobs where payload_json = ? limit 1",
          )
          .get(JSON.stringify({ n }))?.status ?? null
      );
    },
  };
}

function createErrorMapper(errorCode = "JOB_HANDLER_FAILED"): JobErrorMapper {
  return () => errorCode;
}

function createGate(): PromiseWithResolvers<void> {
  return Promise.withResolvers<void>();
}

async function countBusyRows(db: LocalDatabase): Promise<number> {
  return (
    db.sqlite
      .prepare<[], { count: number }>(
        "select count(*) as count from local_jobs where status in ('queued', 'running')",
      )
      .get()?.count ?? 0
  );
}

import { randomUUID } from "node:crypto";
import type {
  JobKind,
  JobPayload,
  JobStatus,
  LocalJobQueueOptions,
  NewJob,
  PersistedJob,
  RegisteredJobHandler,
} from "@/lib/jobs/types";

type LocalJobRow = {
  attempt_count: number;
  created_at: string;
  error_code: string | null;
  finished_at: string | null;
  id: string;
  kind: JobKind;
  payload_json: string;
  started_at: string | null;
  status: JobStatus;
};

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_ERROR_CODE = "JOB_HANDLER_FAILED";
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export class LocalJobQueue {
  private accepting = true;
  private readonly active = new Map<string, Promise<void>>();
  private readonly concurrency: number;
  private draining = false;
  private readonly handlers: Pick<LocalJobQueueOptions, "handlers">["handlers"];
  private started = false;
  private stopPromise: Promise<void> | null = null;
  private stopResolver: (() => void) | null = null;
  private readonly store: LocalJobQueueOptions["store"];

  constructor(options: LocalJobQueueOptions) {
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.handlers = options.handlers;
    this.store = options.store;

    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("queue concurrency must be a positive integer");
    }
  }

  async enqueue<TPayload extends JobPayload>(input: NewJob<TPayload>): Promise<string> {
    if (!this.accepting) {
      throw new Error("queue has stopped");
    }

    const jobId = randomUUID();
    const now = this.timestamp();

    this.store.sqlite
      .prepare(
        "insert into local_jobs (id, kind, payload_json, status, error_code, attempt_count, created_at, started_at, finished_at) values (?, ?, ?, 'queued', null, 0, ?, null, null)",
      )
      .run(jobId, input.kind, JSON.stringify(input.payload), now);

    this.scheduleDrain();
    return jobId;
  }

  async recover(): Promise<void> {
    this.store.sqlite
      .prepare(
        "update local_jobs set status = 'queued', error_code = null, started_at = null, finished_at = null where status = 'running'",
      )
      .run();

    this.scheduleDrain();
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.scheduleDrain();
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.started = false;

    if (this.active.size === 0) {
      return;
    }

    if (!this.stopPromise) {
      this.stopPromise = new Promise<void>((resolve) => {
        this.stopResolver = resolve;
      });
    }

    await this.stopPromise;
  }

  private claimNextQueuedJob(): PersistedJob | null {
    const claim = this.store.sqlite.transaction(() => {
      const row = this.store.sqlite
        .prepare<[], LocalJobRow>(
          "select * from local_jobs where status = 'queued' order by created_at asc, rowid asc, id asc limit 1",
        )
        .get();

      if (!row) {
        return null;
      }

      const startedAt = this.timestamp();
      const result = this.store.sqlite
        .prepare(
          "update local_jobs set status = 'running', attempt_count = attempt_count + 1, error_code = null, started_at = ?, finished_at = null where id = ? and status = 'queued'",
        )
        .run(startedAt, row.id);

      if (result.changes !== 1) {
        return null;
      }

      return this.deserializeRow({
        ...row,
        attempt_count: row.attempt_count + 1,
        error_code: null,
        finished_at: null,
        started_at: startedAt,
        status: "running",
      });
    });

    return claim();
  }

  private deserializeRow(row: LocalJobRow): PersistedJob {
    return {
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      errorCode: row.error_code,
      finishedAt: row.finished_at,
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as JobPayload,
      startedAt: row.started_at,
      status: row.status,
    };
  }

  private launch(job: PersistedJob): void {
    const controller = new AbortController();
    const run = this.runJob(job, controller.signal).finally(() => {
      this.active.delete(job.id);

      if (this.started) {
        this.scheduleDrain();
      } else if (this.active.size === 0) {
        this.resolveStop();
      }
    });

    this.active.set(job.id, run);
  }

  private markFailed(id: string, errorCode: string): void {
    this.store.sqlite
      .prepare(
        "update local_jobs set status = 'failed', error_code = ?, finished_at = ? where id = ?",
      )
      .run(errorCode, this.timestamp(), id);
  }

  private markSucceeded(id: string): void {
    this.store.sqlite
      .prepare("update local_jobs set status = 'succeeded', error_code = null, finished_at = ? where id = ?")
      .run(this.timestamp(), id);
  }

  private resolveStop(): void {
    this.stopResolver?.();
    this.stopPromise = null;
    this.stopResolver = null;
  }

  private async runJob(job: PersistedJob, signal: AbortSignal): Promise<void> {
    let handler: RegisteredJobHandler;
    try {
      handler = this.handlers.get(job.kind);
    } catch {
      this.markFailed(job.id, DEFAULT_ERROR_CODE);
      return;
    }

    try {
      await handler.run({
        attemptCount: job.attemptCount,
        id: job.id,
        kind: job.kind,
        payload: job.payload,
        signal,
      });
      this.markSucceeded(job.id);
    } catch (error) {
      const errorCode = this.mapErrorCode(handler, error);
      this.markFailed(job.id, errorCode);
    }
  }

  private scheduleDrain(): void {
    if (!this.started || this.draining || this.active.size >= this.concurrency) {
      return;
    }

    this.draining = true;
    queueMicrotask(() => {
      try {
        while (this.started && this.active.size < this.concurrency) {
          const job = this.claimNextQueuedJob();
          if (!job) {
            break;
          }

          this.launch(job);
        }
      } finally {
        this.draining = false;

        if (this.started && this.active.size < this.concurrency && this.hasQueuedJobs()) {
          this.scheduleDrain();
        } else if (!this.started && this.active.size === 0) {
          this.resolveStop();
        }
      }
    });
  }

  private hasQueuedJobs(): boolean {
    const row = this.store.sqlite
      .prepare<[], { count: number }>("select count(*) as count from local_jobs where status = 'queued'")
      .get();

    return (row?.count ?? 0) > 0;
  }

  private mapErrorCode(handler: RegisteredJobHandler, error: unknown): string {
    if (!handler.mapError) {
      return DEFAULT_ERROR_CODE;
    }

    try {
      const mapped = handler.mapError(error);
      return ERROR_CODE_PATTERN.test(mapped) ? mapped : DEFAULT_ERROR_CODE;
    } catch {
      return DEFAULT_ERROR_CODE;
    }
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}

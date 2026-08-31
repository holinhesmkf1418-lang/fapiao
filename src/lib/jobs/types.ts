import type { LocalDatabase } from "@/lib/db/types";

export type JobKind = "recognition" | "export" | "maintenance";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export type JobPayload = Record<string, unknown>;

export type NewJob<TPayload extends JobPayload = JobPayload> = {
  kind: JobKind;
  payload: TPayload;
};

export type PersistedJob<TPayload extends JobPayload = JobPayload> = {
  attemptCount: number;
  createdAt: string;
  errorCode: string | null;
  finishedAt: string | null;
  id: string;
  kind: JobKind;
  payload: TPayload;
  startedAt: string | null;
  status: JobStatus;
};

export type JobHandlerContext<TPayload extends JobPayload = JobPayload> = {
  attemptCount: number;
  id: string;
  kind: JobKind;
  payload: TPayload;
  signal: AbortSignal;
};

export type JobHandler<TPayload extends JobPayload = JobPayload> = (
  context: JobHandlerContext<TPayload>,
) => Promise<void>;

export type JobErrorMapper = (error: unknown) => string;

export type JobHandlerDefinition<TPayload extends JobPayload = JobPayload> = {
  mapError?: JobErrorMapper;
  run: JobHandler<TPayload>;
};

export type RegisteredJobHandler = JobHandlerDefinition<JobPayload>;

export interface JobHandlerRegistry {
  get(kind: JobKind): RegisteredJobHandler;
  register<TPayload extends JobPayload>(
    kind: JobKind,
    definition: JobHandlerDefinition<TPayload>,
  ): void;
}

export type LocalJobQueueOptions = {
  concurrency?: number;
  handlers: Pick<JobHandlerRegistry, "get">;
  store: LocalDatabase;
};

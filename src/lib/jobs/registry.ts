import type {
  JobHandlerDefinition,
  JobHandlerRegistry,
  JobKind,
  JobPayload,
  RegisteredJobHandler,
} from "@/lib/jobs/types";

class InMemoryJobHandlerRegistry implements JobHandlerRegistry {
  private readonly handlers = new Map<JobKind, RegisteredJobHandler>();

  get(kind: JobKind): RegisteredJobHandler {
    const handler = this.handlers.get(kind);
    if (!handler) {
      throw new Error(`missing handler for job kind: ${kind}`);
    }

    return handler;
  }

  register<TPayload extends JobPayload>(
    kind: JobKind,
    definition: JobHandlerDefinition<TPayload>,
  ): void {
    if (this.handlers.has(kind)) {
      throw new Error(`duplicate handler registration for job kind: ${kind}`);
    }

    this.handlers.set(kind, definition as RegisteredJobHandler);
  }
}

export function createJobHandlerRegistry(): JobHandlerRegistry {
  return new InMemoryJobHandlerRegistry();
}

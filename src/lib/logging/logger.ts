import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_FILE_NAME = "app.log";
const ALLOWED_KEYS = new Set([
  "event",
  "internalId",
  "stage",
  "errorCode",
] as const);

export type LocalLogEvent = {
  event: string;
  internalId?: string;
  stage?: string;
  errorCode?: string;
};

export interface LocalLogger {
  info(event: LocalLogEvent): void;
  warn(event: LocalLogEvent): void;
  error(event: LocalLogEvent): void;
}

type StoredLogEvent = LocalLogEvent & {
  timestamp: string;
};

function assertSafeFieldValue(value: string | undefined): void {
  if (value === undefined) {
    return;
  }

  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("~")
  ) {
    throw new Error("UNSAFE_LOG_FIELD");
  }
}

function sanitizeEvent(input: LocalLogEvent): StoredLogEvent {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key as keyof LocalLogEvent)) {
      throw new Error("UNSAFE_LOG_FIELD");
    }
  }

  if (!input.event) {
    throw new Error("UNSAFE_LOG_FIELD");
  }

  assertSafeFieldValue(input.event);
  assertSafeFieldValue(input.internalId);
  assertSafeFieldValue(input.stage);
  assertSafeFieldValue(input.errorCode);

  return {
    timestamp: new Date().toISOString(),
    event: input.event,
    internalId: input.internalId ?? "",
    stage: input.stage ?? "",
    errorCode: input.errorCode ?? "",
  };
}

function writeLogLine(logDir: string, event: LocalLogEvent): void {
  mkdirSync(logDir, { recursive: true });

  const logPath = join(logDir, LOG_FILE_NAME);
  const record = sanitizeEvent(event);
  const payload = {
    timestamp: record.timestamp,
    event: record.event,
    ...(record.internalId ? { internalId: record.internalId } : {}),
    ...(record.stage ? { stage: record.stage } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  };

  appendFileSync(logPath, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "a",
  });

  if (existsSync(logPath)) {
    chmodSync(logPath, 0o600);
  }
}

export function createLogger(logDir: string): LocalLogger {
  return {
    info(event) {
      writeLogLine(logDir, event);
    },
    warn(event) {
      writeLogLine(logDir, event);
    },
    error(event) {
      writeLogLine(logDir, event);
    },
  };
}

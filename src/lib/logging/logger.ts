import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_FILE_NAME = "app.log";
const ALLOWED_KEYS = new Set(["event", "internalId", "stage", "errorCode"] as const);
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EVENT_OR_STAGE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){0,2}$/;
const INTERNAL_ID_PATTERNS = [
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,2}$/,
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
];
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){0,2}$/;
const MAX_IDENTIFIER_LENGTH = 64;

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

function assertMatchesPattern(
  value: string | undefined,
  pattern: RegExp | RegExp[],
): void {
  if (value === undefined || value.length > MAX_IDENTIFIER_LENGTH) {
    if (value === undefined) {
      return;
    }

    throw new Error("UNSAFE_LOG_FIELD");
  }

  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  if (!patterns.some((candidate) => candidate.test(value))) {
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

  assertMatchesPattern(input.event, EVENT_OR_STAGE_PATTERN);
  assertMatchesPattern(input.internalId, INTERNAL_ID_PATTERNS);
  assertMatchesPattern(input.stage, EVENT_OR_STAGE_PATTERN);
  assertMatchesPattern(input.errorCode, ERROR_CODE_PATTERN);

  const timestamp = new Date().toISOString();
  if (!ISO_TIMESTAMP_PATTERN.test(timestamp)) {
    throw new Error("UNSAFE_LOG_FIELD");
  }

  return {
    timestamp,
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

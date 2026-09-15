/**
 * Structured logger with mandatory secret redaction.
 *
 * Every value written through this module passes through {@link redactValue}
 * first, so a token that accidentally reaches a log call is scrubbed before it
 * can reach stdout, a PM2 log file, or a crash report. Redaction happens on the
 * way in rather than on the way out so no caller can opt out of it.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const REDACTED = "[redacted]";

/**
 * Ordered most-specific first: a Discord token is replaced whole before any
 * generic rule can split it up.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Discord bot tokens: <base64url>.<base64url>.<base64url>
  /[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{5,}\.[A-Za-z\d_-]{20,}/g,
  // GitHub personal access, app, OAuth, refresh and server tokens
  /\b(?:gh[pousr]_[A-Za-z\d]{16,}|github_pat_[A-Za-z\d_]{20,})\b/g,
  // OpenAI-style keys
  /\bsk-[A-Za-z\d_-]{16,}\b/g,
  // Authorization headers that survived stringification
  /\bBearer\s+[A-Za-z\d._-]{10,}/gi,
];

const SENSITIVE_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|credential)/i;

const MAX_REDACT_DEPTH = 8;

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Scrubs every known secret shape out of a single string. */
export function redactString(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Deep-walks a value, redacting secret-shaped strings and blanking the values
 * of sensitive-looking keys outright.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[truncated]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, depth + 1);
  }
  return output;
}

export interface LogRecord {
  time: string;
  level: LogLevel;
  logger: string;
  msg: string;
  fields: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Returns a logger whose records carry the extra fields. */
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  name?: string;
  /** Fields merged into every record, e.g. `{ guildId }`. */
  bindings?: Record<string, unknown>;
  /** Injected in tests so assertions can read emitted lines. */
  sink?: (line: string) => void;
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const name = options.name ?? "marzano";
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? defaultSink;
  const threshold = LEVEL_PRIORITY[level];

  const emit = (recordLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_PRIORITY[recordLevel] < threshold) return;

    const record: LogRecord = {
      time: new Date().toISOString(),
      level: recordLevel,
      logger: name,
      msg: redactString(message),
      fields: (redactValue({ ...bindings, ...fields }) as Record<string, unknown>) ?? {},
    };

    sink(JSON.stringify(record));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (extra) => createLogger({ level, name, bindings: { ...bindings, ...extra }, sink }),
  };
}

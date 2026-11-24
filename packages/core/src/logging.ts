import { type DestinationStream, type Logger, pino } from "pino";

export type { Logger } from "pino";

const SECRET_KEY_PATTERN =
  /(api[-_]?key|secret|token|password|passphrase|authorization|credential|master[-_]?key)/i;

const REDACT_PATHS = [
  "apiKey",
  "secret",
  "token",
  "password",
  "passphrase",
  "authorization",
  "clientSecret",
  "masterKey",
  "*.apiKey",
  "*.secret",
  "*.token",
  "*.password",
  "*.passphrase",
  "*.authorization",
  "*.clientSecret",
  "*.masterKey",
  "*.headers.authorization",
];

export interface CreateLoggerOptions {
  level?: string;
  name?: string;
  /** Custom destination, mainly useful in tests. Defaults to stderr. */
  destination?: DestinationStream;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth > 8) {
    return "[depth limit]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen, depth + 1));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? "[redacted]"
      : sanitizeValue(item, seen, depth + 1);
  }
  return output;
}

/** Recursively replace values under secret-looking keys. Exported for tests. */
export function sanitizeForLog(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>(), 0);
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

/**
 * Structured logger with recursive redaction. Logs go to stderr so REPL and
 * CLI output on stdout stay clean.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const destination = options.destination ?? pino.destination({ dest: 2, sync: true });
  return pino(
    {
      level: options.level ?? "info",
      name: options.name ?? "myassistant",
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: REDACT_PATHS,
        censor: "[redacted]",
      },
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => sanitizeForLog(object) as Record<string, unknown>,
      },
    },
    destination,
  );
}

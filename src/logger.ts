import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LoggerOptions {
  directory: string;
  retentionFiles: number;
}

export class JsonLogger {
  private readonly directory: string;
  private readonly retentionFiles: number;

  constructor(options: LoggerOptions) {
    this.directory = options.directory;
    this.retentionFiles = options.retentionFiles;
    if (this.directory) {
      mkdirSync(this.directory, { recursive: true });
      this.rotate();
    }
  }

  debug(message: string, meta: Record<string, unknown> = {}): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta: Record<string, unknown> = {}): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta: Record<string, unknown> = {}): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta: Record<string, unknown> = {}): void {
    this.write("error", message, meta);
  }

  private write(level: LogLevel, message: string, meta: Record<string, unknown>): void {
    if (!this.directory) {
      return;
    }

    const safeMeta = sanitize(meta);
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(safeMeta && typeof safeMeta === "object" && !Array.isArray(safeMeta) ? safeMeta : {})
    });
    appendFileSync(join(this.directory, `${dateStamp()}.log`), `${line}\n`, "utf8");
  }

  private rotate(): void {
    if (!this.directory || this.retentionFiles <= 0 || !existsSync(this.directory)) {
      return;
    }

    const logFiles = readdirSync(this.directory)
      .filter((file) => file.endsWith(".log"))
      .sort();
    const removable = logFiles.slice(0, Math.max(0, logFiles.length - this.retentionFiles));
    for (const file of removable) {
      unlinkSync(join(this.directory, file));
    }
  }
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "****";
      url.password = "****";
    }
    return url.toString();
  } catch {
    return value.replace(/(token|password|secret|authorization)=([^&\s]+)/gi, "$1=****");
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/(token|password|secret|authorization|credential)/i.test(key)) {
        output[key] = "****";
      } else {
        output[key] = sanitize(entry);
      }
    }
    return output;
  }
  if (typeof value === "string" && /^[a-z]+:\/\//i.test(value)) {
    return redactUrl(value);
  }
  return value;
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

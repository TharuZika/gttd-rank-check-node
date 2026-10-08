import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LoggerOptions {
  directory: string;
  retentionFiles: number;
  terminal?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export class JsonLogger {
  private readonly directory: string;
  private readonly retentionFiles: number;
  private readonly terminal: boolean;
  private readonly stdout: (line: string) => void;
  private readonly stderr: (line: string) => void;

  constructor(options: LoggerOptions) {
    this.directory = options.directory;
    this.retentionFiles = options.retentionFiles;
    this.terminal = options.terminal ?? true;
    this.stdout = options.stdout ?? ((line) => process.stdout.write(line));
    this.stderr = options.stderr ?? ((line) => process.stderr.write(line));
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
    const safeMeta = sanitize(meta);
    const safeMessage = sanitizeString(message);
    const record = {
      timestamp: new Date().toISOString(),
      level,
      message: safeMessage,
      ...(safeMeta && typeof safeMeta === "object" && !Array.isArray(safeMeta) ? safeMeta : {})
    };
    const line = JSON.stringify(record);

    if (this.terminal) {
      const terminalLine = `${record.timestamp} ${level.toUpperCase()} ${safeMessage} ${JSON.stringify(safeMeta)}\n`;
      (level === "warn" || level === "error" ? this.stderr : this.stdout)(terminalLine);
    }

    if (this.directory) {
      appendFileSync(join(this.directory, `${dateStamp()}.log`), `${line}\n`, "utf8");
    }
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
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|password|secret|authorization|credential|api[_-]?key)/i.test(key)) {
        url.searchParams.set(key, "****");
      }
    }
    return url.toString();
  } catch {
    return value.replace(/(token|password|secret|authorization|credential|api[_-]?key)\s*[:=]\s*([^&\s,;]+)/gi, "$1=****");
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/(token|password|secret|authorization|credential|api[_-]?key)/i.test(key)) {
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
  return typeof value === "string" ? sanitizeString(value) : value;
}

function sanitizeString(value: string): string {
  return value
    .replace(/\b(?:https?|socks5):\/\/[^\s"']+/gi, (url) => redactUrl(url))
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1****")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1****")
    .replace(/\bbearer\s+[^\s,;]+/gi, "Bearer ****");
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

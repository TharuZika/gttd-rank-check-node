import { readFileSync } from "node:fs";
import { AppError } from "./errors.js";
import type { AppConfig, CountryConfig, LocalEndpoint } from "./types.js";

export const DEFAULT_CONFIG_PATH = "C:\\ProgramData\\Findrhost\\RankCheckNode\\config.json";

type JsonRecord = Record<string, unknown>;

export function loadConfig(configPath = process.env.RANK_NODE_CONFIG ?? DEFAULT_CONFIG_PATH): AppConfig {
  const raw = readFileSync(configPath, "utf8");
  return buildConfig(JSON.parse(raw));
}

export function buildConfig(input: unknown): AppConfig {
  const record = requireRecord(input, "config");
  const apiToken = requireString(record.apiToken, "apiToken");
  if (Buffer.byteLength(apiToken, "utf8") < 32) {
    throw new AppError(400, "invalid_config", "apiToken must be at least 32 bytes");
  }

  const gateway = readEndpoint(record.gateway, "gateway");
  const proxyRelay = readEndpoint(record.proxyRelay, "proxyRelay");
  if (gateway.host !== "127.0.0.1" && !isLocalHost(gateway.host)) {
    throw new AppError(400, "invalid_config", "gateway host must be localhost");
  }
  if (proxyRelay.host !== "127.0.0.1" && !isLocalHost(proxyRelay.host)) {
    throw new AppError(400, "invalid_config", "proxyRelay host must be localhost");
  }
  if (gateway.port === proxyRelay.port) {
    throw new AppError(400, "invalid_config", "gateway and proxyRelay ports must be distinct");
  }

  const browserOs = requireRecord(record.browserOs, "browserOs");
  const browserMcpUrl = new URL(requireString(browserOs.mcpUrl, "browserOs.mcpUrl"));
  if (!isLocalHost(browserMcpUrl.hostname)) {
    throw new AppError(400, "invalid_config", "browserOs.mcpUrl must point to localhost");
  }

  const proxyProvider = requireRecord(record.proxyProvider, "proxyProvider");
  const upstreamUrlTemplate = requireString(proxyProvider.upstreamUrlTemplate, "proxyProvider.upstreamUrlTemplate");
  if (!upstreamUrlTemplate.includes("{country}")) {
    throw new AppError(400, "invalid_config", "proxyProvider.upstreamUrlTemplate must include {country}");
  }
  validateUpstreamTemplateProtocol(upstreamUrlTemplate);

  const egressVerification = requireRecord(record.egressVerification, "egressVerification");
  const egressUrl = new URL(requireString(egressVerification.url, "egressVerification.url"));
  const timeoutMs = readPositiveInteger(egressVerification.timeoutMs, "egressVerification.timeoutMs");
  const countryCodePath = requireString(egressVerification.countryCodePath, "egressVerification.countryCodePath");

  const countries = readCountries(record.countries);
  if (!countries.some((country) => country.countryCode === "US")) {
    throw new AppError(400, "invalid_config", "countries must include United States (US)");
  }

  const logging = requireRecord(record.logging, "logging");

  return {
    apiToken,
    gateway,
    proxyRelay,
    browserOs: {
      mcpUrl: browserMcpUrl,
      executablePath: readOptionalString(browserOs.executablePath),
      requestTimeoutMs: readOptionalPositiveInteger(browserOs.requestTimeoutMs, "browserOs.requestTimeoutMs") ?? 10000
    },
    proxyProvider: {
      upstreamUrlTemplate
    },
    egressVerification: {
      url: egressUrl,
      timeoutMs,
      countryCodePath
    },
    countries,
    logging: {
      directory: readOptionalString(logging.directory) ?? "",
      retentionFiles: readNonNegativeInteger(logging.retentionFiles, "logging.retentionFiles")
    }
  };
}

function readEndpoint(value: unknown, label: string): LocalEndpoint {
  const record = requireRecord(value, label);
  const host = readOptionalString(record.host) ?? "127.0.0.1";
  return {
    host,
    port: readPort(record.port, `${label}.port`)
  };
}

function readCountries(value: unknown): CountryConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(400, "invalid_config", "countries must be a non-empty array");
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = requireRecord(entry, `countries[${index}]`);
    const countryCode = normalizeCountryCode(requireString(record.countryCode, `countries[${index}].countryCode`));
    const countryName = requireString(record.countryName, `countries[${index}].countryName`);
    if (seen.has(countryCode)) {
      throw new AppError(400, "invalid_config", `Duplicate country code ${countryCode}`);
    }
    seen.add(countryCode);
    return { countryCode, countryName };
  });
}

export function normalizeCountryCode(countryCode: string): string {
  const normalized = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new AppError(400, "invalid_country", "country must be an ISO-2 country code");
  }
  return normalized;
}

function isLocalHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function readPort(value: unknown, label: string): number {
  const port = readPositiveInteger(value, label);
  if (port > 65535) {
    throw new AppError(400, "invalid_config", `${label} must be between 1 and 65535`);
  }
  return port;
}

function readPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new AppError(400, "invalid_config", `${label} must be a positive integer`);
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return readPositiveInteger(value, label);
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new AppError(400, "invalid_config", `${label} must be a non-negative integer`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(400, "invalid_config", `${label} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(400, "invalid_config", "Optional string value must be a string");
  }
  return value;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError(400, "invalid_config", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function validateUpstreamTemplateProtocol(template: string): void {
  try {
    const sampleUrl = new URL(template.replaceAll("{country}", "US").replaceAll("{session}", "session"));
    if (sampleUrl.protocol !== "http:") {
      throw new AppError(400, "invalid_config", "proxyProvider.upstreamUrlTemplate must be an HTTP upstream proxy URL");
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(400, "invalid_config", "proxyProvider.upstreamUrlTemplate must be a valid HTTP upstream proxy URL");
  }
}

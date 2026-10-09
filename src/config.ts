import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";
import type { AppConfig, CountryConfig, LocalEndpoint, WebshareConfig } from "./types.js";

export const DEFAULT_CONFIG_PATH = "C:\\ProgramData\\Findrhost\\RankCheckNode\\config.json";
export const DEFAULT_ENV_PATH = "C:\\ProgramData\\Findrhost\\RankCheckNode\\.env";
export const DEFAULT_PROJECT_CONFIG_PATH = join(findPackageRoot(dirname(fileURLToPath(import.meta.url))), "config.json");

const WEBSHARE_ENV_KEYS = [
  "WEBSHARE_MODE",
  "WEBSHARE_HOST",
  "WEBSHARE_PORT",
  "WEBSHARE_USERNAME",
  "WEBSHARE_PASSWORD",
  "WEBSHARE_API_KEY",
  "DEFAULT_COUNTRY",
  "WEBSHARE_PLAN_ID"
] as const;
const REQUIRED_WEBSHARE_ENV_KEYS = WEBSHARE_ENV_KEYS.filter((key) => key !== "WEBSHARE_PLAN_ID");
const ISO_3166_ALPHA_2 = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ")
);

type JsonRecord = Record<string, unknown>;
type Environment = Record<string, string | undefined>;

export interface EnvironmentLoadOptions {
  processEnvironment?: Environment;
  serviceEnvPath?: string;
  projectEnvPath?: string;
}

export interface ConfigPathOptions {
  explicitPath?: string;
  servicePath?: string;
  projectPath?: string;
}

export function loadConfig(
  configPath = process.env.RANK_NODE_CONFIG,
  environmentOptions: EnvironmentLoadOptions = {}
): AppConfig {
  const resolvedConfigPath = resolveConfigPath({ explicitPath: configPath });
  const raw = readFileSync(resolvedConfigPath, "utf8");
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new AppError(400, "invalid_config", `Configuration file contains invalid JSON: ${resolvedConfigPath}`);
  }

  const environment = loadRankNodeEnvironment(environmentOptions);
  const webshare = resolveWebshareConfig(environment);
  return buildConfig(input, webshare);
}

export function resolveConfigPath(options: ConfigPathOptions = {}): string {
  const explicitPath = cleanEnvironmentValue(options.explicitPath);
  const servicePath = options.servicePath ?? DEFAULT_CONFIG_PATH;
  const projectPath = options.projectPath ?? DEFAULT_PROJECT_CONFIG_PATH;

  if (explicitPath) {
    if (existsSync(explicitPath)) {
      return explicitPath;
    }
    throw new AppError(
      500,
      "config_not_found",
      `Configuration file not found at ${explicitPath}. Fix RANK_NODE_CONFIG or create that file from config.example.json.`
    );
  }

  if (existsSync(servicePath)) {
    return servicePath;
  }
  if (existsSync(projectPath)) {
    return projectPath;
  }

  throw new AppError(
    500,
    "config_not_found",
    `Configuration file not found. Create ${servicePath}, create ${projectPath} from config.example.json, or set RANK_NODE_CONFIG.`
  );
}

function findPackageRoot(startDirectory: string): string {
  let directory = startDirectory;
  while (true) {
    if (existsSync(join(directory, "package.json"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return startDirectory;
    }
    directory = parent;
  }
}

export function buildConfig(input: unknown, webshare?: WebshareConfig): AppConfig {
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

  const upstreamUrlTemplate = webshare ? undefined : readConfiguredProxyTemplate(record.proxyProvider);
  if (upstreamUrlTemplate !== undefined) {
    if (!upstreamUrlTemplate.includes("{country}")) {
      throw new AppError(400, "invalid_config", "proxyProvider.upstreamUrlTemplate must include {country}");
    }
    validateUpstreamTemplateProtocol(upstreamUrlTemplate);
  }

  const egressVerification = requireRecord(record.egressVerification, "egressVerification");
  const egressUrl = new URL(requireString(egressVerification.url, "egressVerification.url"));
  const timeoutMs = readPositiveInteger(egressVerification.timeoutMs, "egressVerification.timeoutMs");
  const countryCodePath = requireString(egressVerification.countryCodePath, "egressVerification.countryCodePath");

  const countries = webshare && record.countries === undefined ? [] : readCountries(record.countries);
  if (!webshare && !countries.some((country) => country.countryCode === "US")) {
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
    webshare,
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

export function loadRankNodeEnvironment(options: EnvironmentLoadOptions = {}): Environment {
  const processEnvironment = options.processEnvironment ?? process.env;
  const serviceEnvPath = options.serviceEnvPath ?? DEFAULT_ENV_PATH;
  const projectEnvPath = options.projectEnvPath ?? join(process.cwd(), ".env");
  const selectedFile = existsSync(serviceEnvPath)
    ? serviceEnvPath
    : existsSync(projectEnvPath)
      ? projectEnvPath
      : undefined;
  const fileEnvironment = selectedFile ? parseEnvironmentFile(readFileSync(selectedFile, "utf8")) : {};
  const environment: Environment = {};

  for (const key of WEBSHARE_ENV_KEYS) {
    const processValue = cleanEnvironmentValue(processEnvironment[key]);
    const fileValue = cleanEnvironmentValue(fileEnvironment[key]);
    const value = processValue ?? fileValue;
    if (value !== undefined) {
      environment[key] = value;
    }
  }

  return environment;
}

export function resolveWebshareConfig(environment: Environment): WebshareConfig | undefined {
  const configuredKeys = WEBSHARE_ENV_KEYS.filter((key) => cleanEnvironmentValue(environment[key]) !== undefined);
  if (configuredKeys.length === 0) {
    return undefined;
  }

  const missing = REQUIRED_WEBSHARE_ENV_KEYS.filter((key) => cleanEnvironmentValue(environment[key]) === undefined);
  if (missing.length > 0) {
    throw new AppError(400, "invalid_config", `Incomplete Webshare configuration. Missing: ${missing.join(", ")}`);
  }

  const mode = environment.WEBSHARE_MODE!.trim().toLowerCase();
  if (mode !== "backbone") {
    throw new AppError(400, "invalid_config", "WEBSHARE_MODE must be backbone");
  }
  const host = environment.WEBSHARE_HOST!.trim();
  if (!/^[a-z0-9.-]+$/i.test(host)) {
    throw new AppError(400, "invalid_config", "WEBSHARE_HOST must be a hostname");
  }
  const port = Number(environment.WEBSHARE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(400, "invalid_config", "WEBSHARE_PORT must be between 1 and 65535");
  }

  return {
    mode,
    host,
    port,
    username: environment.WEBSHARE_USERNAME!.trim(),
    password: environment.WEBSHARE_PASSWORD!.trim(),
    apiKey: environment.WEBSHARE_API_KEY!.trim(),
    defaultCountry: normalizeCountryCode(environment.DEFAULT_COUNTRY!),
    planId: cleanEnvironmentValue(environment.WEBSHARE_PLAN_ID)
  };
}

function readConfiguredProxyTemplate(value: unknown): string {
  const proxyProvider = requireRecord(value, "proxyProvider");
  return requireString(proxyProvider.upstreamUrlTemplate, "proxyProvider.upstreamUrlTemplate");
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

function parseEnvironmentFile(contents: string): Environment {
  const environment: Environment = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    environment[key] = value;
  }
  return environment;
}

function cleanEnvironmentValue(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

export function normalizeCountryCode(countryCode: string): string {
  const normalized = countryCode.trim().toUpperCase();
  if (!isIsoCountryCode(normalized)) {
    throw new AppError(400, "invalid_country", "country must be an ISO-3166-1 alpha-2 country code");
  }
  return normalized;
}

export function isIsoCountryCode(countryCode: string): boolean {
  return ISO_3166_ALPHA_2.has(countryCode);
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

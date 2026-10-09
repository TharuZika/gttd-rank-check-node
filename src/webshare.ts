import { AppError } from "./errors.js";
import { isIsoCountryCode, normalizeCountryCode } from "./config.js";
import type { JsonLogger } from "./logger.js";
import type { CountryConfig, WebshareConfig } from "./types.js";

const DEFAULT_API_URL = "https://proxy.webshare.io/api/v2/proxy/list/";
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_BACKOFF_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 2;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface WebshareCountryProviderOptions {
  apiKey: string;
  mode: WebshareConfig["mode"];
  planId?: string;
  proxyHost?: string;
  proxyPort?: number;
  fetch?: Fetch;
  now?: () => number;
  logger?: Pick<JsonLogger, "warn">;
  apiUrl?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  refreshBackoffMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ProxyListPage {
  count?: number;
  next: string | null;
  results: ProxyListResult[];
}

interface ProxyListResult {
  id?: unknown;
  country_code?: unknown;
  valid?: unknown;
  username?: unknown;
  password?: unknown;
}

interface WebshareProxyRecord {
  identity: string;
  username: string;
  password: string;
}

interface ProxySnapshot {
  countries: CountryConfig[];
  proxiesByCountry: Map<string, WebshareProxyRecord[]>;
}

interface CachedProxySnapshot extends ProxySnapshot {
  refreshedAt: number;
}

export class WebshareCountryProvider {
  private readonly apiKey: string;
  private readonly mode: WebshareConfig["mode"];
  private readonly planId?: string;
  private readonly proxyHost: string;
  private readonly proxyPort: number;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly logger?: Pick<JsonLogger, "warn">;
  private readonly apiUrl: URL;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly refreshBackoffMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private cached?: CachedProxySnapshot;
  private refreshInFlight?: Promise<ProxySnapshot>;
  private nextRefreshAllowedAt = 0;
  private readonly lastSelectedProxyIdentityByCountry = new Map<string, string>();

  constructor(options: WebshareCountryProviderOptions) {
    this.apiKey = options.apiKey;
    this.mode = options.mode;
    this.planId = options.planId;
    this.proxyHost = options.proxyHost ?? "p.webshare.io";
    this.proxyPort = options.proxyPort ?? 80;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.apiUrl = new URL(options.apiUrl ?? DEFAULT_API_URL);
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.refreshBackoffMs = options.refreshBackoffMs ?? DEFAULT_REFRESH_BACKOFF_MS;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async listCountries(): Promise<CountryConfig[]> {
    const snapshot = await this.loadSnapshot();
    return cloneCountries(snapshot.countries);
  }

  async selectProxy(rawCountryCode: string): Promise<string> {
    const countryCode = normalizeCountryCode(rawCountryCode);
    const snapshot = await this.loadSnapshot();
    const proxies = snapshot.proxiesByCountry.get(countryCode) ?? [];
    if (proxies.length === 0) {
      throw new AppError(
        502,
        "webshare_proxy_unavailable",
        "No usable Webshare proxy is allocated for the selected country"
      );
    }

    const lastIdentity = this.lastSelectedProxyIdentityByCountry.get(countryCode);
    const lastIndex = lastIdentity === undefined
      ? -1
      : proxies.findIndex((proxy) => proxy.identity === lastIdentity);
    const proxy = proxies[(lastIndex + 1) % proxies.length];
    this.lastSelectedProxyIdentityByCountry.set(countryCode, proxy.identity);

    const upstream = new URL(`http://${this.proxyHost}:${this.proxyPort}`);
    upstream.username = encodeURIComponent(proxy.username);
    upstream.password = encodeURIComponent(proxy.password);
    return upstream.href;
  }

  private async loadSnapshot(): Promise<ProxySnapshot> {
    if (this.cached && this.now() - this.cached.refreshedAt < this.cacheTtlMs) {
      return this.cached;
    }
    if (this.cached && this.now() < this.nextRefreshAllowedAt) {
      return this.cached;
    }

    try {
      this.refreshInFlight ??= this.fetchProxySnapshot();
      const snapshot = await this.refreshInFlight;
      this.cached = { ...snapshot, refreshedAt: this.now() };
      this.nextRefreshAllowedAt = 0;
      return this.cached;
    } catch (error) {
      if (this.cached) {
        this.nextRefreshAllowedAt = this.now() + this.refreshBackoffMs;
        this.logger?.warn("webshare_countries_stale_cache", {
          cachedCountryCount: this.cached.countries.length,
          error: safeErrorCode(error)
        });
        return this.cached;
      }
      throw new AppError(502, "webshare_countries_unavailable", "Unable to load allocated Webshare countries");
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async fetchProxySnapshot(): Promise<ProxySnapshot> {
    const proxiesByCountry = new Map<string, WebshareProxyRecord[]>();
    const proxyIdentities = new Set<string>();
    const visited = new Set<string>();
    let nextUrl: URL | undefined = this.createInitialUrl();
    let expectedProxyCount: number | undefined;
    let receivedProxyCount = 0;

    while (nextUrl) {
      if (nextUrl.origin !== this.apiUrl.origin || visited.has(nextUrl.href)) {
        throw new Error("Invalid Webshare pagination URL");
      }
      visited.add(nextUrl.href);
      const response = await this.fetchPage(nextUrl);
      const page = await readProxyListPage(response);
      expectedProxyCount ??= page.count;
      receivedProxyCount += page.results.length;
      for (const result of page.results) {
        const code = String(result.country_code ?? "").trim().toUpperCase();
        const username = typeof result.username === "string" ? result.username : "";
        const password = typeof result.password === "string" ? result.password : "";
        if (!isIsoCountryCode(code) || result.valid !== true || username === "" || password === "") {
          continue;
        }
        const rawId = typeof result.id === "string" || typeof result.id === "number"
          ? String(result.id).trim()
          : "";
        const identity = rawId ? `id:${rawId}` : `credentials:${code}:${username}:${password}`;
        if (proxyIdentities.has(identity)) {
          continue;
        }
        proxyIdentities.add(identity);
        const proxies = proxiesByCountry.get(code) ?? [];
        proxies.push({ identity, username, password });
        proxiesByCountry.set(code, proxies);
      }
      nextUrl = page.next ? new URL(page.next, nextUrl) : undefined;
    }

    if (expectedProxyCount !== undefined && receivedProxyCount < expectedProxyCount) {
      throw new Error("Incomplete Webshare pagination response");
    }

    const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    const countries = [...proxiesByCountry.keys()]
      .map((countryCode) => ({
        countryCode,
        countryName: displayNames.of(countryCode) ?? countryCode
      }))
      .sort((a, b) => a.countryName.localeCompare(b.countryName) || a.countryCode.localeCompare(b.countryCode));
    return { countries, proxiesByCountry };
  }

  private createInitialUrl(): URL {
    const url = new URL(this.apiUrl);
    url.searchParams.set("mode", this.mode);
    url.searchParams.set("page", "1");
    url.searchParams.set("page_size", "100");
    if (this.planId) {
      url.searchParams.set("plan_id", this.planId);
    }
    return url;
  }

  private async fetchPage(url: URL): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const response = await this.fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Token ${this.apiKey}`
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await this.sleep(readRetryAfterMs(response.headers.get("retry-after"), this.now()));
        continue;
      }
      if (!response.ok) {
        throw new Error(`Webshare request failed with HTTP ${response.status}`);
      }
      return response;
    }
    throw new Error("Webshare rate limit retry exhausted");
  }
}

async function readProxyListPage(response: Response): Promise<ProxyListPage> {
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid Webshare response");
  }
  const record = payload as Record<string, unknown>;
  if (
    !Array.isArray(record.results)
    || (record.next !== null && typeof record.next !== "string")
    || (record.count !== undefined && (!Number.isInteger(record.count) || Number(record.count) < 0))
  ) {
    throw new Error("Invalid Webshare response");
  }
  return {
    count: record.count === undefined ? undefined : Number(record.count),
    next: record.next as string | null,
    results: record.results.filter((entry): entry is ProxyListResult => Boolean(entry && typeof entry === "object"))
  };
}

function readRetryAfterMs(value: string | null, now: number): number {
  if (value !== null && value.trim() !== "") {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }
    const retryAt = Date.parse(value);
    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(0, retryAt - now), 60_000);
    }
  }
  return 60_000;
}

function cloneCountries(countries: CountryConfig[]): CountryConfig[] {
  return countries.map((country) => ({ ...country }));
}

function safeErrorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "webshare_request_failed";
}

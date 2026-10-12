import { randomInt } from "node:crypto";
import { normalizeCountryCode } from "./config.js";
import { AppError } from "./errors.js";
import { redactUrl } from "./logger.js";
import type { JsonLogger } from "./logger.js";
import type { CountryConfig, EgressVerificationResult, UpstreamEndpointMetadata, WebshareConfig } from "./types.js";

const MAX_ROTATION_ATTEMPTS = 3;

export interface RelayController {
  readonly localProxyUrl?: string;
  updateUpstream(url: string): Promise<void>;
  closeActiveTunnels(): void;
}

export interface VerifyEgressRequest {
  countryCode: string;
  sessionId: string;
  upstreamProxyUrl: string;
  localProxyUrl: string;
}

export interface VerifyBrowserEgressRequest extends VerifyEgressRequest {}

export interface ResolveUpstreamProxyRequest {
  countryCode: string;
  sessionId: string;
  attempt: number;
}

export interface ProxyStateManagerOptions {
  countries: CountryConfig[];
  loadCountries?: () => Promise<CountryConfig[]>;
  upstreamUrlTemplate?: string;
  resolveUpstreamProxy?: (request: ResolveUpstreamProxyRequest) => Promise<string>;
  refreshProxyList?: () => Promise<void>;
  verifyBrowserEgress: (request: VerifyBrowserEgressRequest) => Promise<EgressVerificationResult>;
  upstreamMode?: WebshareConfig["mode"];
  relay: RelayController;
  verifyEgress: (request: VerifyEgressRequest) => Promise<EgressVerificationResult>;
  createSessionId?: () => string;
  logger?: Pick<JsonLogger, "info" | "warn">;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ProxyActivationResult {
  countryCode: string;
  countryName: string;
  sessionId: string;
  observedCountryCode: string;
  observedIp: string;
  verifiedAt: string;
  rotationAttempts: number;
  ipChanged: boolean | null;
  upstream: UpstreamEndpointMetadata;
  nodeEgress: EgressVerificationResult;
  browserEgress: EgressVerificationResult;
}

export interface ProxySnapshot {
  ready: boolean;
  switching: boolean;
  activeCountryCode?: string;
  activeCountryName?: string;
  sessionId?: string;
  observedCountryCode?: string;
  observedIp?: string;
  verifiedAt?: string;
  upstreamProxy?: string;
  upstream?: UpstreamEndpointMetadata;
  nodeEgress?: EgressVerificationResult;
  browserEgress?: EgressVerificationResult;
}

export class ProxyStateManager {
  private readonly countries: CountryConfig[];
  private readonly loadCountries?: () => Promise<CountryConfig[]>;
  private readonly upstreamUrlTemplate?: string;
  private readonly resolveUpstreamProxy?: (request: ResolveUpstreamProxyRequest) => Promise<string>;
  private readonly refreshProxyList?: () => Promise<void>;
  private readonly verifyBrowserEgress: (request: VerifyBrowserEgressRequest) => Promise<EgressVerificationResult>;
  private readonly upstreamMode?: WebshareConfig["mode"];
  private readonly relay: RelayController;
  private readonly verifyEgress: (request: VerifyEgressRequest) => Promise<EgressVerificationResult>;
  private readonly createSessionId: () => string;
  private readonly logger?: Pick<JsonLogger, "info" | "warn">;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private current?: ProxySnapshot;
  private switching = false;

  constructor(options: ProxyStateManagerOptions) {
    this.countries = options.countries;
    this.loadCountries = options.loadCountries;
    this.upstreamUrlTemplate = options.upstreamUrlTemplate;
    this.resolveUpstreamProxy = options.resolveUpstreamProxy;
    this.refreshProxyList = options.refreshProxyList;
    this.verifyBrowserEgress = options.verifyBrowserEgress;
    this.upstreamMode = options.upstreamMode;
    if (!this.upstreamUrlTemplate && !this.resolveUpstreamProxy) {
      throw new AppError(500, "proxy_provider_missing", "A proxy provider must be configured");
    }
    this.relay = options.relay;
    this.verifyEgress = options.verifyEgress;
    this.createSessionId = options.createSessionId ?? (() => randomInt(1, 2_147_483_647).toString());
    this.logger = options.logger;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async listCountries(): Promise<CountryConfig[]> {
    const countries = this.loadCountries ? await this.loadCountries() : this.countries;
    return countries.map((country) => ({ ...country }));
  }

  snapshot(): ProxySnapshot {
    return {
      ready: this.current?.ready ?? false,
      switching: this.switching,
      activeCountryCode: this.current?.activeCountryCode,
      activeCountryName: this.current?.activeCountryName,
      sessionId: this.current?.sessionId,
      observedCountryCode: this.current?.observedCountryCode,
      observedIp: this.current?.observedIp,
      verifiedAt: this.current?.verifiedAt,
      upstreamProxy: this.current?.upstreamProxy,
      upstream: this.current?.upstream,
      nodeEgress: this.current?.nodeEgress,
      browserEgress: this.current?.browserEgress
    };
  }

  isReady(): boolean {
    return this.current?.ready === true && !this.switching;
  }

  async activateCountry(rawCountryCode: string): Promise<ProxyActivationResult> {
    if (this.switching) {
      throw new AppError(409, "proxy_switch_in_progress", "A proxy country switch is already in progress");
    }

    this.switching = true;
    const previousIp = this.current?.observedIp;
    const firstActivation = this.current?.ready !== true;
    this.current = undefined;

    try {
      const countryCode = normalizeCountryCode(rawCountryCode);
      await this.refreshProxyList?.();
      const countries = await this.listCountries();
      const country = countries.find((entry) => entry.countryCode === countryCode);
      if (!country) {
        throw new AppError(400, "unsupported_country", `Unsupported country ${countryCode}`);
      }

      let sessionId = "";
      let upstreamProxyUrl = "";
      let verification: EgressVerificationResult | undefined;
      let browserVerification: EgressVerificationResult | undefined;
      let rotationAttempts = 0;

      for (let attempt = 1; attempt <= MAX_ROTATION_ATTEMPTS; attempt += 1) {
        rotationAttempts = attempt;
        sessionId = this.createSessionId();
        upstreamProxyUrl = this.resolveUpstreamProxy
          ? await this.resolveUpstreamProxy({ countryCode, sessionId, attempt })
          : expandProxyTemplate(this.upstreamUrlTemplate!, countryCode, sessionId);
        this.relay.closeActiveTunnels();
        await this.relay.updateUpstream(upstreamProxyUrl);
        try {
          verification = await this.verifyEgress({
            countryCode,
            sessionId,
            upstreamProxyUrl,
            localProxyUrl: this.relay.localProxyUrl ?? ""
          });
        } catch (error) {
          if (!isRateLimitedEgress(error) || attempt >= MAX_ROTATION_ATTEMPTS) {
            throw error;
          }

          const retryAfterMs = getRetryAfterMs(error);
          this.logger?.warn("proxy_egress_rate_limited", {
            verificationHost: getVerificationHost(error),
            statusCode: getStatusCode(error),
            retryAfterMs,
            rotationAttempt: attempt
          });
          await this.sleep(retryAfterMs);
          continue;
        }

        if (!verification.ok || verification.observedCountryCode !== countryCode) {
          this.current = undefined;
          throw new AppError(502, "egress_country_mismatch", "Verified egress country mismatch", {
            expectedCountryCode: countryCode,
            observedCountryCode: verification.observedCountryCode
          });
        }

        const observedIp = verification.observedIp?.trim();
        if (!observedIp) {
          throw new AppError(502, "egress_ip_missing", "Egress verification did not return an IP address");
        }
        verification = sanitizeEgress({ ...verification, observedIp });

        browserVerification = await this.verifyBrowserEgress({
          countryCode,
          sessionId,
          upstreamProxyUrl,
          localProxyUrl: this.relay.localProxyUrl ?? ""
        });

        if (!browserVerification.ok) {
          throw new AppError(502, "browseros_egress_failed", "BrowserOS egress verification failed", {
            observedCountryCode: browserVerification.observedCountryCode
          });
        }
        if (browserVerification.observedCountryCode !== countryCode) {
          throw new AppError(502, "browseros_egress_country_mismatch", "BrowserOS egress country mismatch", {
            expectedCountryCode: countryCode,
            observedCountryCode: browserVerification.observedCountryCode
          });
        }
        if (!browserVerification.observedIp?.trim()) {
          throw new AppError(502, "browseros_egress_ip_missing", "BrowserOS egress verification did not return an IP address");
        }
        browserVerification = sanitizeEgress({ ...browserVerification, observedIp: browserVerification.observedIp.trim() });

        if (firstActivation || verification.observedIp !== previousIp) {
          break;
        }
      }

      if (!verification) {
        throw new AppError(502, "egress_verification_failed", "Unable to verify proxy egress");
      }
      const observedIp = verification.observedIp;
      if (!observedIp) {
        throw new AppError(502, "egress_ip_missing", "Egress verification did not return an IP address");
      }
      if (!browserVerification) {
        throw new AppError(502, "browseros_egress_failed", "BrowserOS egress verification did not complete");
      }

      const ipChanged = firstActivation
        ? null
        : observedIp !== previousIp;

      const verifiedAt = new Date().toISOString();
      this.current = {
        ready: true,
        switching: false,
        activeCountryCode: country.countryCode,
        activeCountryName: country.countryName,
        sessionId,
        observedCountryCode: verification.observedCountryCode,
        observedIp,
        verifiedAt,
        upstreamProxy: redactUrl(upstreamProxyUrl),
        upstream: describeUpstream(upstreamProxyUrl, this.upstreamMode),
        nodeEgress: verification,
        browserEgress: browserVerification
      };

      const logMeta = {
        countryCode: country.countryCode,
        observedCountryCode: verification.observedCountryCode,
        observedIp,
        rotationAttempts,
        ipChanged,
        upstream: describeUpstream(upstreamProxyUrl, this.upstreamMode),
        nodeEgress: verification,
        browserEgress: browserVerification
      };
      if (ipChanged === false) {
        this.logger?.warn("proxy_ip_unchanged", logMeta);
      } else {
        this.logger?.info(ipChanged === true ? "proxy_ip_changed" : "proxy_country_activated", logMeta);
      }

      return {
        countryCode: country.countryCode,
        countryName: country.countryName,
        sessionId,
        observedCountryCode: verification.observedCountryCode,
        observedIp,
        verifiedAt,
        rotationAttempts,
        ipChanged,
        upstream: describeUpstream(upstreamProxyUrl, this.upstreamMode),
        nodeEgress: verification,
        browserEgress: browserVerification
      };
    } finally {
      this.switching = false;
    }
  }
}

const DEFAULT_EGRESS_RETRY_DELAY_MS = 1000;

function isRateLimitedEgress(error: unknown): error is AppError {
  return error instanceof AppError && error.code === "egress_rate_limited";
}

function getRetryAfterMs(error: AppError): number {
  return typeof error.details?.retryAfterMs === "number"
    ? Math.min(Math.max(0, error.details.retryAfterMs), 10_000)
    : DEFAULT_EGRESS_RETRY_DELAY_MS;
}

function getStatusCode(error: AppError): number | undefined {
  return typeof error.details?.statusCode === "number" ? error.details.statusCode : undefined;
}

function getVerificationHost(error: AppError): string {
  return typeof error.details?.verificationHost === "string" ? error.details.verificationHost : "unknown";
}

function describeUpstream(value: string, mode?: WebshareConfig["mode"]): UpstreamEndpointMetadata {
  const url = new URL(value);
  return {
    mode,
    protocol: url.protocol,
    host: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80))
  };
}

function sanitizeEgress(value: EgressVerificationResult): EgressVerificationResult {
  return {
    ok: value.ok,
    observedCountryCode: value.observedCountryCode,
    observedIp: value.observedIp
  };
}

export function expandProxyTemplate(template: string, countryCode: string, sessionId: string): string {
  return template.replaceAll("{country}", countryCode).replaceAll("{session}", sessionId);
}

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
        verification = await this.verifyEgress({
          countryCode,
          sessionId,
          upstreamProxyUrl,
          localProxyUrl: this.relay.localProxyUrl ?? ""
        });

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

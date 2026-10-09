import { randomInt } from "node:crypto";
import { normalizeCountryCode } from "./config.js";
import { AppError } from "./errors.js";
import { redactUrl } from "./logger.js";
import type { JsonLogger } from "./logger.js";
import type { CountryConfig, EgressVerificationResult } from "./types.js";

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
}

export class ProxyStateManager {
  private readonly countries: CountryConfig[];
  private readonly loadCountries?: () => Promise<CountryConfig[]>;
  private readonly upstreamUrlTemplate?: string;
  private readonly resolveUpstreamProxy?: (request: ResolveUpstreamProxyRequest) => Promise<string>;
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
      upstreamProxy: this.current?.upstreamProxy
    };
  }

  isReady(): boolean {
    return this.current?.ready === true && !this.switching;
  }

  async activateCountry(rawCountryCode: string): Promise<ProxyActivationResult> {
    const countryCode = normalizeCountryCode(rawCountryCode);
    const countries = await this.listCountries();
    const country = countries.find((entry) => entry.countryCode === countryCode);
    if (!country) {
      throw new AppError(400, "unsupported_country", `Unsupported country ${countryCode}`);
    }
    if (this.switching) {
      throw new AppError(409, "proxy_switch_in_progress", "A proxy country switch is already in progress");
    }

    this.switching = true;
    const previousIp = this.current?.observedIp;
    const firstActivation = this.current?.ready !== true;
    this.current = undefined;

    try {
      let sessionId = "";
      let upstreamProxyUrl = "";
      let verification: EgressVerificationResult | undefined;
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
        verification = { ...verification, observedIp };

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
        upstreamProxy: redactUrl(upstreamProxyUrl)
      };

      const logMeta = {
        countryCode: country.countryCode,
        observedCountryCode: verification.observedCountryCode,
        observedIp,
        rotationAttempts,
        ipChanged
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
        ipChanged
      };
    } finally {
      this.switching = false;
    }
  }
}

export function expandProxyTemplate(template: string, countryCode: string, sessionId: string): string {
  return template.replaceAll("{country}", countryCode).replaceAll("{session}", sessionId);
}

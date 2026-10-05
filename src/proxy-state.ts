import { randomBytes } from "node:crypto";
import { normalizeCountryCode } from "./config.js";
import { AppError } from "./errors.js";
import { redactUrl } from "./logger.js";
import type { CountryConfig, EgressVerificationResult } from "./types.js";

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

export interface ProxyStateManagerOptions {
  countries: CountryConfig[];
  upstreamUrlTemplate: string;
  relay: RelayController;
  verifyEgress: (request: VerifyEgressRequest) => Promise<EgressVerificationResult>;
}

export interface ProxyActivationResult {
  countryCode: string;
  countryName: string;
  sessionId: string;
  observedCountryCode: string;
  observedIp?: string;
  verifiedAt: string;
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
  private readonly upstreamUrlTemplate: string;
  private readonly relay: RelayController;
  private readonly verifyEgress: (request: VerifyEgressRequest) => Promise<EgressVerificationResult>;
  private current?: ProxySnapshot;
  private switching = false;

  constructor(options: ProxyStateManagerOptions) {
    this.countries = options.countries;
    this.upstreamUrlTemplate = options.upstreamUrlTemplate;
    this.relay = options.relay;
    this.verifyEgress = options.verifyEgress;
  }

  listCountries(): CountryConfig[] {
    return this.countries.map((country) => ({ ...country }));
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
    const country = this.countries.find((entry) => entry.countryCode === countryCode);
    if (!country) {
      throw new AppError(400, "unsupported_country", `Unsupported country ${countryCode}`);
    }
    if (this.switching) {
      throw new AppError(409, "proxy_switch_in_progress", "A proxy country switch is already in progress");
    }

    this.switching = true;
    const sessionId = randomBytes(8).toString("hex");
    const upstreamProxyUrl = expandProxyTemplate(this.upstreamUrlTemplate, countryCode, sessionId);

    try {
      this.relay.closeActiveTunnels();
      await this.relay.updateUpstream(upstreamProxyUrl);
      const verification = await this.verifyEgress({
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

      const verifiedAt = new Date().toISOString();
      this.current = {
        ready: true,
        switching: false,
        activeCountryCode: country.countryCode,
        activeCountryName: country.countryName,
        sessionId,
        observedCountryCode: verification.observedCountryCode,
        observedIp: verification.observedIp,
        verifiedAt,
        upstreamProxy: redactUrl(upstreamProxyUrl)
      };

      return {
        countryCode: country.countryCode,
        countryName: country.countryName,
        sessionId,
        observedCountryCode: verification.observedCountryCode,
        observedIp: verification.observedIp,
        verifiedAt
      };
    } finally {
      this.switching = false;
    }
  }
}

export function expandProxyTemplate(template: string, countryCode: string, sessionId: string): string {
  return template.replaceAll("{country}", countryCode).replaceAll("{session}", sessionId);
}

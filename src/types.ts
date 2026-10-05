export interface CountryConfig {
  countryCode: string;
  countryName: string;
}

export interface LocalEndpoint {
  host: string;
  port: number;
}

export interface AppConfig {
  apiToken: string;
  gateway: LocalEndpoint;
  proxyRelay: LocalEndpoint;
  browserOs: {
    mcpUrl: URL;
    executablePath?: string;
    requestTimeoutMs: number;
  };
  proxyProvider: {
    upstreamUrlTemplate: string;
  };
  egressVerification: {
    url: URL;
    timeoutMs: number;
    countryCodePath: string;
  };
  countries: CountryConfig[];
  logging: {
    directory: string;
    retentionFiles: number;
  };
}

export interface EgressVerificationResult {
  ok: boolean;
  observedCountryCode: string;
  observedIp?: string;
}

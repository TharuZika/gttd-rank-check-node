export interface CountryConfig {
  countryCode: string;
  countryName: string;
}

export interface LocalEndpoint {
  host: string;
  port: number;
}

export interface WebshareConfig {
  mode: "backbone";
  host: string;
  port: number;
  username: string;
  password: string;
  apiKey: string;
  defaultCountry: string;
  planId?: string;
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
  webshare?: WebshareConfig;
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

import test from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../src/config.js";

const baseConfig = {
  apiToken: "t".repeat(32),
  gateway: { host: "127.0.0.1", port: 8787 },
  proxyRelay: { host: "127.0.0.1", port: 8788 },
  browserOs: { mcpUrl: "http://127.0.0.1:3211/mcp", executablePath: "C:\\BrowserOS\\BrowserOS.exe" },
  proxyProvider: {
    upstreamUrlTemplate: "http://user-country-{country}-session-{session}:secret@example.proxy:8080"
  },
  egressVerification: {
    url: "https://example.test/geo",
    timeoutMs: 5000,
    countryCodePath: "country_code"
  },
  countries: [
    { countryCode: "us", countryName: "United States" },
    { countryCode: "gb", countryName: "United Kingdom" }
  ],
  logging: {
    directory: "C:\\ProgramData\\Findrhost\\RankCheckNode\\logs",
    retentionFiles: 7
  }
};

test("normalizes a valid config and keeps private services bound to localhost", () => {
  const config = buildConfig(baseConfig);

  assert.equal(config.apiToken, "t".repeat(32));
  assert.equal(config.gateway.host, "127.0.0.1");
  assert.equal(config.proxyRelay.port, 8788);
  assert.equal(config.browserOs.mcpUrl.href, "http://127.0.0.1:3211/mcp");
  assert.deepEqual(config.countries.map((country) => country.countryCode), ["US", "GB"]);
});

test("requires a long API token, a US country entry, and a country placeholder", () => {
  assert.throws(() => buildConfig({ ...baseConfig, apiToken: "short" }), /apiToken/i);
  assert.throws(
    () => buildConfig({ ...baseConfig, countries: [{ countryCode: "gb", countryName: "United Kingdom" }] }),
    /United States/i
  );
  assert.throws(
    () => buildConfig({ ...baseConfig, proxyProvider: { upstreamUrlTemplate: "http://proxy.example:8080" } }),
    /country/i
  );
  assert.throws(
    () => buildConfig({
      ...baseConfig,
      proxyProvider: { upstreamUrlTemplate: "socks5://user-country-{country}:secret@example.proxy:1080" }
    }),
    /HTTP upstream/i
  );
});

test("rejects externally bound private service URLs and duplicate gateway ports", () => {
  assert.throws(
    () => buildConfig({ ...baseConfig, browserOs: { mcpUrl: "http://browser.example/mcp" } }),
    /localhost/i
  );
  assert.throws(
    () => buildConfig({ ...baseConfig, proxyRelay: { host: "127.0.0.1", port: 8787 } }),
    /distinct/i
  );
});

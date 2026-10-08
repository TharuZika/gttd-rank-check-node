import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, loadRankNodeEnvironment, resolveWebshareConfig } from "../src/config.js";

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

test("enables Webshare only when every required environment value is present", () => {
  assert.equal(resolveWebshareConfig({}), undefined);

  const webshare = resolveWebshareConfig({
    WEBSHARE_MODE: "backbone",
    WEBSHARE_HOST: "p.webshare.io",
    WEBSHARE_PORT: "80",
    WEBSHARE_USERNAME: "proxyuser",
    WEBSHARE_PASSWORD: "proxy-password",
    WEBSHARE_API_KEY: "api-key",
    DEFAULT_COUNTRY: "us",
    WEBSHARE_PLAN_ID: "plan-123"
  });

  assert.deepEqual(webshare, {
    mode: "backbone",
    host: "p.webshare.io",
    port: 80,
    username: "proxyuser",
    password: "proxy-password",
    apiKey: "api-key",
    defaultCountry: "US",
    planId: "plan-123"
  });

  assert.throws(
    () => resolveWebshareConfig({
      WEBSHARE_MODE: "backbone",
      WEBSHARE_USERNAME: "do-not-print-this"
    }),
    (error) => {
      assert.match(String(error), /Missing: .*WEBSHARE_HOST/);
      assert.doesNotMatch(String(error), /do-not-print-this/);
      return true;
    }
  );
});

test("loads the ProgramData environment first and uses the project file as a fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "rank-node-env-"));
  const servicePath = join(root, "service.env");
  const projectPath = join(root, "project.env");
  writeFileSync(projectPath, "WEBSHARE_HOST=project.proxy\nDEFAULT_COUNTRY=gb\n", "utf8");

  try {
    assert.deepEqual(loadRankNodeEnvironment({
      processEnvironment: {},
      serviceEnvPath: servicePath,
      projectEnvPath: projectPath
    }), {
      WEBSHARE_HOST: "project.proxy",
      DEFAULT_COUNTRY: "gb"
    });

    writeFileSync(servicePath, "WEBSHARE_HOST=service.proxy\nDEFAULT_COUNTRY=us\n", "utf8");
    assert.deepEqual(loadRankNodeEnvironment({
      processEnvironment: { DEFAULT_COUNTRY: "ca" },
      serviceEnvPath: servicePath,
      projectEnvPath: projectPath
    }), {
      WEBSHARE_HOST: "service.proxy",
      DEFAULT_COUNTRY: "ca"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses the env-backed Webshare template without requiring static countries", () => {
  const { proxyProvider: _proxyProvider, countries: _countries, ...configWithoutStaticProxy } = baseConfig;
  const webshare = resolveWebshareConfig({
    WEBSHARE_MODE: "backbone",
    WEBSHARE_HOST: "p.webshare.io",
    WEBSHARE_PORT: "80",
    WEBSHARE_USERNAME: "proxyuser",
    WEBSHARE_PASSWORD: "p@ss word",
    WEBSHARE_API_KEY: "api-key",
    DEFAULT_COUNTRY: "us"
  });
  assert.ok(webshare);

  const config = buildConfig(configWithoutStaticProxy, webshare);

  assert.deepEqual(config.countries, []);
  assert.equal(config.webshare?.defaultCountry, "US");
  assert.equal(
    config.proxyProvider.upstreamUrlTemplate,
    "http://proxyuser-{country}-{session}:p%40ss%20word@p.webshare.io:80"
  );
});

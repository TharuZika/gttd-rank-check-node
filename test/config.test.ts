import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfig,
  DEFAULT_PROJECT_CONFIG_PATH,
  loadConfig,
  loadRankNodeEnvironment,
  resolveConfigPath,
  resolveWebshareConfig
} from "../src/config.js";
import { AppError } from "../src/errors.js";

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

test("prefers an explicit config, then ProgramData, then the project config", () => {
  const root = mkdtempSync(join(tmpdir(), "rank-node-config-"));
  const explicitPath = join(root, "explicit.json");
  const servicePath = join(root, "service.json");
  const projectPath = join(root, "config.json");

  try {
    writeFileSync(explicitPath, "{}", "utf8");
    writeFileSync(servicePath, "{}", "utf8");
    writeFileSync(projectPath, "{}", "utf8");

    assert.equal(resolveConfigPath({ explicitPath, servicePath, projectPath }), explicitPath);
    assert.equal(resolveConfigPath({ servicePath, projectPath }), servicePath);

    rmSync(servicePath);
    assert.equal(resolveConfigPath({ servicePath, projectPath }), projectPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports actionable locations when no config file exists", () => {
  const root = mkdtempSync(join(tmpdir(), "rank-node-missing-config-"));
  const servicePath = join(root, "service.json");
  const projectPath = join(root, "config.json");

  try {
    assert.throws(
      () => resolveConfigPath({ servicePath, projectPath }),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "config_not_found");
        assert.match(error.message, /RANK_NODE_CONFIG/);
        assert.match(error.message, new RegExp(servicePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(error.message, new RegExp(projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a missing explicit config before validating a partial Webshare environment", () => {
  const root = mkdtempSync(join(tmpdir(), "rank-node-explicit-config-"));
  const missingPath = join(root, "missing.json");

  try {
    assert.throws(
      () => loadConfig(missingPath, {
        processEnvironment: { WEBSHARE_MODE: "backbone" },
        serviceEnvPath: join(root, "missing-service.env"),
        projectEnvPath: join(root, "missing-project.env")
      }),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "config_not_found");
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports malformed JSON without echoing config contents", () => {
  const root = mkdtempSync(join(tmpdir(), "rank-node-invalid-json-"));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, '{"apiToken":"sentinel-config-secret', "utf8");

  try {
    assert.throws(
      () => loadConfig(configPath, {
        processEnvironment: {},
        serviceEnvPath: join(root, "missing-service.env"),
        projectEnvPath: join(root, "missing-project.env")
      }),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "invalid_config");
        assert.match(error.message, /invalid JSON/i);
        assert.doesNotMatch(error.message, /sentinel-config-secret/);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derives the project config fallback independently of the launch directory", () => {
  const originalDirectory = process.cwd();
  const otherDirectory = mkdtempSync(join(tmpdir(), "rank-node-other-cwd-"));
  const cwdConfigPath = join(otherDirectory, "config.json");
  writeFileSync(cwdConfigPath, "{}", "utf8");

  try {
    process.chdir(otherDirectory);
    const servicePath = join(otherDirectory, "missing-service.json");
    try {
      const selectedPath = resolveConfigPath({ servicePath });
      assert.equal(selectedPath, DEFAULT_PROJECT_CONFIG_PATH);
      assert.notEqual(selectedPath, cwdConfigPath);
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "config_not_found");
      assert.match(error.message, new RegExp(DEFAULT_PROJECT_CONFIG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(error.message, new RegExp(cwdConfigPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    process.chdir(originalDirectory);
    rmSync(otherDirectory, { recursive: true, force: true });
  }
});

test("uses API-selected Webshare records without constructing synthetic credentials", () => {
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
  assert.equal(config.proxyProvider.upstreamUrlTemplate, undefined);
});

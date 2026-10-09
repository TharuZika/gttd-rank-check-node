import test from "node:test";
import assert from "node:assert/strict";
import { ProxyStateManager } from "../src/proxy-state.js";
import { AppError } from "../src/errors.js";
import { JsonLogger } from "../src/logger.js";

const countries = [{ countryCode: "US", countryName: "United States" }];

test("activates a country by expanding the upstream template, rotating a session, and verifying egress", async () => {
  const relayUpdates: string[] = [];
  const destroyed: string[] = [];

  const manager = new ProxyStateManager({
    countries,
    upstreamUrlTemplate: "http://user-country-{country}-session-{session}:secret@example.proxy:8080",
    relay: {
      updateUpstream: async (url) => {
        relayUpdates.push(url);
      },
      closeActiveTunnels: () => destroyed.push("closed")
    },
    createSessionId: () => "123456",
    verifyEgress: async ({ countryCode }) => ({
      ok: true,
      observedCountryCode: countryCode,
      observedIp: "203.0.113.10"
    })
  });

  const result = await manager.activateCountry("us");

  assert.equal(result.countryCode, "US");
  assert.equal(result.sessionId, "123456");
  assert.equal(result.rotationAttempts, 1);
  assert.equal(result.ipChanged, null);
  assert.equal(relayUpdates.length, 1);
  assert.match(relayUpdates[0], /country-US-session-/);
  assert.equal(destroyed.length, 1);
  assert.equal(manager.snapshot().ready, true);
  assert.equal(manager.snapshot().upstreamProxy, "http://****:****@example.proxy:8080/");
});

test("retries numeric sticky sessions until the verified IP changes", async () => {
  const sessionIds = ["1001", "1002", "1003", "1004"];
  const observedIps = ["203.0.113.10", "203.0.113.10", "203.0.113.10", "203.0.113.11"];
  const relayUpdates: string[] = [];
  const manager = new ProxyStateManager({
    countries,
    upstreamUrlTemplate: "http://user-country-{country}-session-{session}:secret@example.proxy:8080",
    relay: {
      updateUpstream: async (url) => {
        relayUpdates.push(url);
      },
      closeActiveTunnels: () => undefined
    },
    createSessionId: () => sessionIds.shift() ?? "9999",
    verifyEgress: async ({ countryCode }) => ({
      ok: true,
      observedCountryCode: countryCode,
      observedIp: observedIps.shift()
    })
  });

  await manager.activateCountry("US");
  const rotated = await manager.activateCountry("US");

  assert.equal(rotated.rotationAttempts, 3);
  assert.equal(rotated.ipChanged, true);
  assert.equal(rotated.observedIp, "203.0.113.11");
  assert.equal(relayUpdates.length, 4);
  assert.ok(relayUpdates.every((url) => /session-\d+/.test(url)));
});

test("uses exact asynchronously selected proxy records instead of expanding the legacy template", async () => {
  const selectedUrls = [
    "http://allocated-user-1:allocated-password-1@p.webshare.io:80",
    "http://allocated-user-2:allocated-password-2@p.webshare.io:80"
  ];
  const resolverRequests: Array<{ countryCode: string; sessionId: string; attempt: number }> = [];
  const relayUpdates: string[] = [];
  const manager = new ProxyStateManager({
    countries,
    upstreamUrlTemplate: "http://generated-{country}-{session}:wrong@p.webshare.io:80",
    resolveUpstreamProxy: async (request) => {
      resolverRequests.push(request);
      return selectedUrls.shift() ?? "http://allocated-user-3:allocated-password-3@p.webshare.io:80";
    },
    relay: {
      updateUpstream: async (url) => {
        relayUpdates.push(url);
      },
      closeActiveTunnels: () => undefined
    },
    createSessionId: () => "123456",
    verifyEgress: async ({ countryCode }) => ({
      ok: true,
      observedCountryCode: countryCode,
      observedIp: "203.0.113.12"
    })
  });

  const result = await manager.activateCountry("us");

  assert.equal(result.sessionId, "123456");
  assert.deepEqual(resolverRequests, [{ countryCode: "US", sessionId: "123456", attempt: 1 }]);
  assert.deepEqual(relayUpdates, ["http://allocated-user-1:allocated-password-1@p.webshare.io:80"]);
  assert.doesNotMatch(relayUpdates[0], /generated-US-123456/);
});

test("continues with a warning when three verified sessions return the same IP", async () => {
  let nextSessionId = 2000;
  const warnings: string[] = [];
  const manager = new ProxyStateManager({
    countries,
    upstreamUrlTemplate: "http://user-country-{country}-session-{session}:secret@example.proxy:8080",
    relay: {
      updateUpstream: async () => undefined,
      closeActiveTunnels: () => undefined
    },
    createSessionId: () => String(++nextSessionId),
    verifyEgress: async ({ countryCode }) => ({
      ok: true,
      observedCountryCode: countryCode,
      observedIp: "203.0.113.10"
    }),
    logger: new JsonLogger({
      directory: "",
      retentionFiles: 0,
      stdout: () => undefined,
      stderr: (line) => warnings.push(line)
    })
  });

  await manager.activateCountry("US");
  const result = await manager.activateCountry("US");

  assert.equal(result.rotationAttempts, 3);
  assert.equal(result.ipChanged, false);
  assert.match(warnings.join("\n"), /proxy_ip_unchanged/);
});

test("rejects unsupported countries and mismatched verified egress", async () => {
  const manager = new ProxyStateManager({
    countries,
    upstreamUrlTemplate: "http://user-country-{country}:secret@example.proxy:8080",
    relay: {
      updateUpstream: async () => undefined,
      closeActiveTunnels: () => undefined
    },
    verifyEgress: async () => ({ ok: true, observedCountryCode: "GB", observedIp: "203.0.113.20" })
  });

  await assert.rejects(() => manager.activateCountry("GB"), (error) => {
    assert.equal(error instanceof AppError, true);
    assert.equal((error as AppError).statusCode, 400);
    return true;
  });

  await assert.rejects(() => manager.activateCountry("US"), (error) => {
    assert.equal(error instanceof AppError, true);
    assert.equal((error as AppError).statusCode, 502);
    return true;
  });
});

test("clears proxy readiness when a later rotation cannot verify egress", async () => {
  let verificationCount = 0;
  const manager = new ProxyStateManager({
    countries,
    upstreamUrlTemplate: "http://user-country-{country}-{session}:secret@example.proxy:8080",
    relay: {
      updateUpstream: async () => undefined,
      closeActiveTunnels: () => undefined
    },
    createSessionId: () => String(3000 + verificationCount),
    verifyEgress: async () => {
      verificationCount += 1;
      if (verificationCount > 1) {
        throw new AppError(504, "egress_timeout", "Egress verification timed out");
      }
      return { ok: true, observedCountryCode: "US", observedIp: "203.0.113.30" };
    }
  });

  await manager.activateCountry("US");
  assert.equal(manager.isReady(), true);

  await assert.rejects(() => manager.activateCountry("US"), /timed out/i);
  assert.equal(manager.isReady(), false);
});

test("rejects egress verification that does not include an IP address", async () => {
  const manager = new ProxyStateManager({
    countries,
    upstreamUrlTemplate: "http://user-country-{country}-{session}:secret@example.proxy:8080",
    relay: {
      updateUpstream: async () => undefined,
      closeActiveTunnels: () => undefined
    },
    verifyEgress: async () => ({ ok: true, observedCountryCode: "US" })
  });

  await assert.rejects(
    () => manager.activateCountry("US"),
    (error) => {
      assert.equal((error as AppError).statusCode, 502);
      assert.equal((error as AppError).code, "egress_ip_missing");
      return true;
    }
  );
  assert.equal(manager.isReady(), false);
});

test("serializes country switches and reports a conflict while a switch is active", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });

  const manager = new ProxyStateManager({
    countries,
    upstreamUrlTemplate: "http://user-country-{country}:secret@example.proxy:8080",
    relay: {
      updateUpstream: async () => undefined,
      closeActiveTunnels: () => undefined
    },
    verifyEgress: async () => {
      await waiting;
      return { ok: true, observedCountryCode: "US", observedIp: "203.0.113.30" };
    }
  });

  const firstSwitch = manager.activateCountry("US");
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(() => manager.activateCountry("US"), (error) => {
    assert.equal(error instanceof AppError, true);
    assert.equal((error as AppError).statusCode, 409);
    return true;
  });

  release();
  await firstSwitch;
});

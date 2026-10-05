import test from "node:test";
import assert from "node:assert/strict";
import { ProxyStateManager } from "../src/proxy-state.js";
import { AppError } from "../src/errors.js";

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
    verifyEgress: async ({ countryCode }) => ({
      ok: true,
      observedCountryCode: countryCode,
      observedIp: "203.0.113.10"
    })
  });

  const result = await manager.activateCountry("us");

  assert.equal(result.countryCode, "US");
  assert.match(result.sessionId, /^[a-f0-9]{16}$/);
  assert.equal(relayUpdates.length, 1);
  assert.match(relayUpdates[0], /country-US-session-/);
  assert.equal(destroyed.length, 1);
  assert.equal(manager.snapshot().ready, true);
  assert.equal(manager.snapshot().upstreamProxy, "http://****:****@example.proxy:8080/");
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

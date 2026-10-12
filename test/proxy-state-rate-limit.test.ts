import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { ProxyStateManager } from "../src/proxy-state.js";

function successEgress() {
  return { ok: true as const, observedCountryCode: "US", observedIp: "198.51.100.10" };
}

function managerWithVerification(
  verifyEgress: (attempt: number) => Promise<ReturnType<typeof successEgress>>,
  delays: number[]
) {
  let attempt = 0;
  return new ProxyStateManager({
    countries: [{ countryCode: "US", countryName: "United States" }],
    refreshProxyList: async () => undefined,
    resolveUpstreamProxy: async ({ attempt: rotationAttempt }) => `http://user-${rotationAttempt}:password@proxy.example:8080`,
    relay: {
      localProxyUrl: "http://127.0.0.1:8788",
      updateUpstream: async () => undefined,
      closeActiveTunnels: () => undefined
    },
    verifyEgress: async () => verifyEgress(++attempt),
    verifyBrowserEgress: async () => successEgress(),
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    }
  });
}

test("rotates and retries Node verification after a rate limit", async () => {
  const delays: number[] = [];
  const manager = managerWithVerification((attempt) => {
    if (attempt < 3) {
      return Promise.reject(new AppError(502, "egress_rate_limited", "Egress verification was rate limited", {
        statusCode: 429,
        verificationHost: "example.test",
        retryAfterMs: 250
      }));
    }
    return Promise.resolve(successEgress());
  }, delays);

  const result = await manager.activateCountry("US");

  assert.equal(result.rotationAttempts, 3);
  assert.deepEqual(delays, [250, 250]);
  assert.equal(manager.snapshot().ready, true);
});

test("does not retry non-rate-limit egress failures and remains unready after exhaustion", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const manager = managerWithVerification(() => {
    attempts += 1;
    return Promise.reject(new AppError(502, "egress_http_error", "Egress verification failed", {
      statusCode: 500,
      verificationHost: "example.test"
    }));
  }, delays);

  await assert.rejects(manager.activateCountry("US"), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "egress_http_error");
    return true;
  });
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
  assert.equal(manager.snapshot().ready, false);
});

test("leaves the node unready after three rate-limited attempts", async () => {
  const delays: number[] = [];
  const manager = managerWithVerification(() => Promise.reject(new AppError(
    502,
    "egress_rate_limited",
    "Egress verification was rate limited",
    { statusCode: 429, verificationHost: "example.test" }
  )), delays);

  await assert.rejects(manager.activateCountry("US"), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "egress_rate_limited");
    return true;
  });
  assert.deepEqual(delays, [1000, 1000]);
  assert.equal(manager.snapshot().ready, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { JsonLogger } from "../src/logger.js";
import { WebshareCountryProvider } from "../src/webshare.js";

function proxyRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "proxy-1",
    country_code: "US",
    valid: true,
    username: "allocated-user-1",
    password: "allocated-password-1",
    proxy_address: "191.96.254.138",
    port: 10000,
    ...overrides
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("loads every allocated Webshare country across pages and deduplicates the result", async () => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const responses = [
    jsonResponse({
      next: "https://proxy.webshare.io/api/v2/proxy/list/?mode=backbone&page=2&page_size=100&plan_id=plan-1",
      results: [
        proxyRecord(),
        proxyRecord({ id: "proxy-2", country_code: "gb", username: "allocated-user-2" })
      ]
    }),
    jsonResponse({
      next: null,
      results: [
        proxyRecord(),
        proxyRecord({ id: "proxy-3", country_code: "DE", username: "allocated-user-3" })
      ]
    })
  ];
  const provider = new WebshareCountryProvider({
    apiKey: "secret-api-key",
    mode: "backbone",
    planId: "plan-1",
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined
      });
      return responses.shift() ?? jsonResponse({ next: null, results: [] });
    }
  });

  const countries = await provider.listCountries();

  assert.deepEqual(countries.map((country) => country.countryCode).sort(), ["DE", "GB", "US"]);
  assert.equal(new Set(countries.map((country) => country.countryName)).size, 3);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /mode=backbone/);
  assert.match(requests[0].url, /plan_id=plan-1/);
  assert.equal(requests[0].authorization, "Token secret-api-key");
});

test("uses a five-minute country cache and falls back to stale data after refresh errors", async () => {
  let now = 1_000;
  let calls = 0;
  const warnings: string[] = [];
  const provider = new WebshareCountryProvider({
    apiKey: "secret-api-key",
    mode: "backbone",
    now: () => now,
    fetch: async () => {
      calls += 1;
      if (calls > 1) throw new Error("network failure with secret-api-key");
      return jsonResponse({ next: null, results: [proxyRecord()] });
    },
    logger: new JsonLogger({
      directory: "",
      retentionFiles: 0,
      stdout: () => undefined,
      stderr: (line) => warnings.push(line)
    })
  });

  assert.deepEqual(await provider.listCountries(), [{ countryCode: "US", countryName: "United States" }]);
  now += 299_999;
  assert.deepEqual(await provider.listCountries(), [{ countryCode: "US", countryName: "United States" }]);
  assert.equal(calls, 1);

  now += 2;
  assert.deepEqual(await provider.listCountries(), [{ countryCode: "US", countryName: "United States" }]);
  assert.equal(calls, 2);
  assert.deepEqual(await provider.listCountries(), [{ countryCode: "US", countryName: "United States" }]);
  assert.equal(calls, 2);
  assert.match(warnings.join("\n"), /webshare_countries_stale_cache/);
  assert.doesNotMatch(warnings.join("\n"), /secret-api-key/);
});

test("returns a sanitized 502 when Webshare countries cannot be loaded without a cache", async () => {
  const provider = new WebshareCountryProvider({
    apiKey: "secret-api-key",
    mode: "backbone",
    fetch: async () => jsonResponse({ detail: "secret-api-key is invalid" }, 401)
  });

  await assert.rejects(
    () => provider.listCountries(),
    (error) => {
      assert.equal((error as { statusCode?: number }).statusCode, 502);
      assert.equal((error as { code?: string }).code, "webshare_countries_unavailable");
      assert.doesNotMatch(String(error), /secret-api-key/);
      return true;
    }
  );
});

test("continues pagination beyond one hundred pages until Webshare reports completion", async () => {
  let calls = 0;
  const provider = new WebshareCountryProvider({
    apiKey: "api-key",
    mode: "backbone",
    fetch: async (input) => {
      calls += 1;
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page") || "1");
      return jsonResponse({
        count: 101,
        next: page < 101
          ? `https://proxy.webshare.io/api/v2/proxy/list/?mode=backbone&page=${page + 1}&page_size=100`
          : null,
        results: [proxyRecord({
          id: `proxy-${page}`,
          country_code: page % 2 === 0 ? "GB" : "US",
          username: `allocated-user-${page}`
        })]
      });
    }
  });

  const countries = await provider.listCountries();

  assert.equal(calls, 101);
  assert.deepEqual(countries.map((country) => country.countryCode).sort(), ["GB", "US"]);
});

test("honors Retry-After and retries a rate-limited Webshare page", async () => {
  let calls = 0;
  const waits: number[] = [];
  const provider = new WebshareCountryProvider({
    apiKey: "api-key",
    mode: "backbone",
    sleep: async (milliseconds: number) => {
      waits.push(milliseconds);
    },
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      return jsonResponse({ count: 1, next: null, results: [proxyRecord()] });
    }
  });

  assert.deepEqual(await provider.listCountries(), [{ countryCode: "US", countryName: "United States" }]);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
});

test("selects exact allocated Backbone credentials through the configured Webshare endpoint", async () => {
  let calls = 0;
  const provider = new WebshareCountryProvider({
    apiKey: "api-key",
    mode: "backbone",
    proxyHost: "p.webshare.io",
    proxyPort: 80,
    fetch: async () => {
      calls += 1;
      return jsonResponse({
        count: 2,
        next: null,
        results: [
          proxyRecord(),
          proxyRecord({
            id: "proxy-2",
            username: "allocated-user-2",
            password: "allocated-password-2",
            proxy_address: "198.51.100.25",
            port: 10000
          })
        ]
      });
    }
  });

  assert.deepEqual(await provider.listCountries(), [{ countryCode: "US", countryName: "United States" }]);
  const first = new URL(await provider.selectProxy("us"));
  const second = new URL(await provider.selectProxy("US"));
  const wrapped = new URL(await provider.selectProxy("US"));

  assert.equal(calls, 1);
  assert.equal(first.hostname, "p.webshare.io");
  assert.equal(Number(first.port || "80"), 80);
  assert.equal(decodeURIComponent(first.username), "allocated-user-1");
  assert.equal(decodeURIComponent(first.password), "allocated-password-1");
  assert.notEqual(first.hostname, "191.96.254.138");
  assert.equal(decodeURIComponent(second.username), "allocated-user-2");
  assert.equal(decodeURIComponent(second.password), "allocated-password-2");
  assert.equal(wrapped.href, first.href);
  assert.doesNotMatch(first.username, /-US-|-[A-Za-z]{2}-\d+$/);
});

test("ignores unusable allocated records and returns a sanitized selection error", async () => {
  const provider = new WebshareCountryProvider({
    apiKey: "secret-api-key",
    mode: "backbone",
    proxyHost: "p.webshare.io",
    proxyPort: 80,
    fetch: async () => jsonResponse({
      count: 3,
      next: null,
      results: [
        proxyRecord({ valid: false, password: "invalid-secret" }),
        proxyRecord({ id: "proxy-2", username: "", password: "missing-user-secret" }),
        proxyRecord({ id: "proxy-3", country_code: "ZZ", password: "bad-country-secret" })
      ]
    })
  });

  assert.deepEqual(await provider.listCountries(), []);
  await assert.rejects(
    () => provider.selectProxy("ZZ"),
    (error) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      assert.equal((error as { code?: string }).code, "invalid_country");
      return true;
    }
  );
  await assert.rejects(
    () => provider.selectProxy("US"),
    (error) => {
      assert.equal((error as { statusCode?: number }).statusCode, 502);
      assert.equal((error as { code?: string }).code, "webshare_proxy_unavailable");
      assert.doesNotMatch(String(error), /secret-api-key|invalid-secret|missing-user-secret|bad-country-secret/);
      return true;
    }
  );
});

test("preserves allocated credentials containing percent sequences and special characters", async () => {
  const username = " user%2F:name/é ";
  const password = "p%word%40 :/é";
  const provider = new WebshareCountryProvider({
    apiKey: "api-key",
    mode: "backbone",
    proxyHost: "p.webshare.io",
    proxyPort: 80,
    fetch: async () => jsonResponse({
      count: 1,
      next: null,
      results: [proxyRecord({ username, password })]
    })
  });

  const selected = new URL(await provider.selectProxy("US"));

  assert.equal(decodeURIComponent(selected.username), username);
  assert.equal(decodeURIComponent(selected.password), password);
});

test("continues round-robin selection by stable record identity after cache reordering", async () => {
  let now = 0;
  let calls = 0;
  const first = proxyRecord();
  const second = proxyRecord({ id: "proxy-2", username: "allocated-user-2" });
  const provider = new WebshareCountryProvider({
    apiKey: "api-key",
    mode: "backbone",
    proxyHost: "p.webshare.io",
    proxyPort: 80,
    cacheTtlMs: 1,
    now: () => now,
    fetch: async () => {
      calls += 1;
      return jsonResponse({
        count: 2,
        next: null,
        results: calls === 1 ? [first, second] : [second, first]
      });
    }
  });

  const selectedFirst = new URL(await provider.selectProxy("US"));
  now = 2;
  const selectedAfterRefresh = new URL(await provider.selectProxy("US"));

  assert.equal(calls, 2);
  assert.equal(decodeURIComponent(selectedFirst.username), "allocated-user-1");
  assert.equal(decodeURIComponent(selectedAfterRefresh.username), "allocated-user-2");
});

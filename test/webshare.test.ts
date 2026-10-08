import test from "node:test";
import assert from "node:assert/strict";
import { JsonLogger } from "../src/logger.js";
import { WebshareCountryProvider } from "../src/webshare.js";

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
        { country_code: "US" },
        { country_code: "gb" }
      ]
    }),
    jsonResponse({
      next: null,
      results: [
        { country_code: "US" },
        { country_code: "DE" }
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
      return jsonResponse({ next: null, results: [{ country_code: "US" }] });
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
        results: [{ country_code: page % 2 === 0 ? "GB" : "US" }]
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
      return jsonResponse({ count: 1, next: null, results: [{ country_code: "US" }] });
    }
  });

  assert.deepEqual(await provider.listCountries(), [{ countryCode: "US", countryName: "United States" }]);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
});

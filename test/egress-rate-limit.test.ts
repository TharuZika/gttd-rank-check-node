import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { verifyEgressViaProxy } from "../src/egress.js";

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return new URL(`http://127.0.0.1:${address.port}`);
}

function verificationOptions(proxyUrl: URL) {
  return {
    localProxyUrl: proxyUrl.href,
    verificationUrl: "http://example.test/geo",
    expectedCountryCode: "US",
    timeoutMs: 1000,
    countryCodePath: "country_code"
  };
}

test("sends the explicit rank-node user agent for HTTP verification", async () => {
  let userAgent: string | undefined;
  const proxy = createServer((request, response) => {
    userAgent = request.headers["user-agent"];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ country_code: "US", ip: "198.51.100.10" }));
  });
  const proxyUrl = await listen(proxy);

  try {
    const result = await verifyEgressViaProxy(verificationOptions(proxyUrl));
    assert.equal(result.ok, true);
    assert.equal(userAgent, "gttd-rank-check-node/1.0");
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  }
});

test("classifies HTTP 429 and preserves bounded retry metadata without response content", async () => {
  const proxy = createServer((_request, response) => {
    response.writeHead(429, {
      "content-type": "text/plain",
      "retry-after": "120"
    });
    response.end("credentialed upstream details must not escape");
  });
  const proxyUrl = await listen(proxy);

  try {
    await assert.rejects(
      verifyEgressViaProxy(verificationOptions(proxyUrl)),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "egress_rate_limited");
        assert.equal(error.details?.statusCode, 429);
        assert.equal(error.details?.verificationHost, "example.test");
        assert.equal(error.details?.retryAfterMs, 10000);
        assert.doesNotMatch(JSON.stringify(error.details), /credentialed upstream details/i);
        return true;
      }
    );
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  }
});

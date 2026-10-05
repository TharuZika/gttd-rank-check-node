import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createGatewayServer } from "../src/gateway.js";
import { buildConfig } from "../src/config.js";
import { JsonLogger } from "../src/logger.js";
import { ProxyStateManager } from "../src/proxy-state.js";
import { ProxyRelay } from "../src/proxy-relay.js";
import { verifyEgressViaProxy } from "../src/egress.js";

const apiToken = "z".repeat(32);

function testConfig(browserMcpUrl: string, browserRequestTimeoutMs = 1000) {
  return buildConfig({
    apiToken,
    gateway: { host: "127.0.0.1", port: 8787 },
    proxyRelay: { host: "127.0.0.1", port: 8788 },
    browserOs: { mcpUrl: browserMcpUrl, requestTimeoutMs: browserRequestTimeoutMs },
    proxyProvider: {
      upstreamUrlTemplate: "http://user-country-{country}-session-{session}:secret@example.proxy:8080"
    },
    egressVerification: {
      url: "http://127.0.0.1/geo",
      timeoutMs: 1000,
      countryCodePath: "country_code"
    },
    countries: [{ countryCode: "US", countryName: "United States" }],
    logging: { directory: "", retentionFiles: 0 }
  });
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  const port = (address as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

async function request(url: string, init: RequestInit = {}) {
  return fetch(url, init);
}

test("serves health publicly and protects countries, ready, proxy, and browser endpoints", async () => {
  const browser = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const browserServer = await listen(browser);
  const config = testConfig(`${browserServer.url}/mcp`);
  const relay = new ProxyRelay({ host: "127.0.0.1", port: 0 }, new JsonLogger({ directory: "", retentionFiles: 0 }));
  const manager = new ProxyStateManager({
    countries: config.countries,
    upstreamUrlTemplate: config.proxyProvider.upstreamUrlTemplate,
    relay,
    verifyEgress: async () => ({ ok: true, observedCountryCode: "US", observedIp: "203.0.113.40" })
  });
  const app = createGatewayServer({ config, proxyState: manager, logger: new JsonLogger({ directory: "", retentionFiles: 0 }) });
  const gateway = await listen(app);

  try {
    const health = await request(`${gateway.url}/health`);
    assert.equal(health.status, 200);

    const unauthorized = await request(`${gateway.url}/countries`);
    assert.equal(unauthorized.status, 401);

    const countries = await request(`${gateway.url}/countries`, {
      headers: { authorization: `Bearer ${apiToken}` }
    });
    assert.equal(countries.status, 200);
    assert.deepEqual(await countries.json(), {
      countries: [{ countryCode: "US", countryName: "United States" }]
    });

    const notReady = await request(`${gateway.url}/ready`, {
      headers: { authorization: `Bearer ${apiToken}` }
    });
    assert.equal(notReady.status, 503);

    const switched = await request(`${gateway.url}/proxy?country=US`, {
      headers: { authorization: `Bearer ${apiToken}` }
    });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json() as { countryCode: string }).countryCode, "US");
  } finally {
    await gateway.close();
    await browserServer.close();
  }
});

test("streams BrowserOS MCP responses through /browser only after proxy readiness", async () => {
  let observedBody = "";
  const browser = createServer((req: IncomingMessage, res: ServerResponse) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/mcp");
    assert.equal(req.headers.accept, "text/event-stream");
    req.on("data", (chunk) => {
      observedBody += chunk.toString("utf8");
    });
    req.on("end", () => {
      res.writeHead(202, {
        "content-type": "text/event-stream",
        "mcp-session-id": "session-123"
      });
      res.write("event: message\n");
      res.end("data: ok\n\n");
    });
  });
  const browserServer = await listen(browser);
  const config = testConfig(`${browserServer.url}/mcp`);
  const relay = new ProxyRelay({ host: "127.0.0.1", port: 0 }, new JsonLogger({ directory: "", retentionFiles: 0 }));
  const manager = new ProxyStateManager({
    countries: config.countries,
    upstreamUrlTemplate: config.proxyProvider.upstreamUrlTemplate,
    relay,
    verifyEgress: async () => ({ ok: true, observedCountryCode: "US", observedIp: "203.0.113.50" })
  });
  const app = createGatewayServer({ config, proxyState: manager, logger: new JsonLogger({ directory: "", retentionFiles: 0 }) });
  const gateway = await listen(app);

  try {
    await request(`${gateway.url}/proxy?country=US`, {
      headers: { authorization: `Bearer ${apiToken}` }
    });

    const response = await request(`${gateway.url}/browser`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        accept: "text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
    });

    assert.equal(response.status, 202);
    assert.equal(response.headers.get("mcp-session-id"), "session-123");
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(await response.text(), "event: message\ndata: ok\n\n");
    assert.match(observedBody, /tools\/list/);
  } finally {
    await gateway.close();
    await browserServer.close();
  }
});

test("reports BrowserOS as not ready for a broken MCP path", async () => {
  const browser = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  const browserServer = await listen(browser);
  const config = testConfig(`${browserServer.url}/wrong-mcp`);
  const relay = new ProxyRelay({ host: "127.0.0.1", port: 0 }, new JsonLogger({ directory: "", retentionFiles: 0 }));
  const manager = new ProxyStateManager({
    countries: config.countries,
    upstreamUrlTemplate: config.proxyProvider.upstreamUrlTemplate,
    relay,
    verifyEgress: async () => ({ ok: true, observedCountryCode: "US", observedIp: "203.0.113.60" })
  });
  const app = createGatewayServer({ config, proxyState: manager, logger: new JsonLogger({ directory: "", retentionFiles: 0 }) });
  const gateway = await listen(app);

  try {
    await request(`${gateway.url}/proxy?country=US`, {
      headers: { authorization: `Bearer ${apiToken}` }
    });

    const response = await request(`${gateway.url}/ready`, {
      headers: { authorization: `Bearer ${apiToken}` }
    });

    assert.equal(response.status, 503);
    assert.equal((await response.json() as { ready: boolean }).ready, false);
  } finally {
    await gateway.close();
    await browserServer.close();
  }
});

test("returns 504 when BrowserOS accepts a /browser request but stalls before headers", async () => {
  const browser = createServer((_req: IncomingMessage, _res: ServerResponse) => {
    // Keep the socket open without sending headers.
  });
  const browserServer = await listen(browser);
  const config = testConfig(`${browserServer.url}/mcp`, 50);
  const relay = new ProxyRelay({ host: "127.0.0.1", port: 0 }, new JsonLogger({ directory: "", retentionFiles: 0 }));
  const manager = new ProxyStateManager({
    countries: config.countries,
    upstreamUrlTemplate: config.proxyProvider.upstreamUrlTemplate,
    relay,
    verifyEgress: async () => ({ ok: true, observedCountryCode: "US", observedIp: "203.0.113.70" })
  });
  const app = createGatewayServer({ config, proxyState: manager, logger: new JsonLogger({ directory: "", retentionFiles: 0 }) });
  const gateway = await listen(app);

  try {
    await request(`${gateway.url}/proxy?country=US`, {
      headers: { authorization: `Bearer ${apiToken}` }
    });

    const response = await request(`${gateway.url}/browser`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json"
      },
      body: "{}"
    });

    assert.equal(response.status, 504);
  } finally {
    await gateway.close();
    await browserServer.close();
  }
});

test("verifies egress through an HTTP proxy response and rejects country mismatches", async () => {
  const proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
    assert.match(req.url ?? "", /^http:\/\/geo\.example\/lookup/);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ country_code: "US", ip: "198.51.100.7" }));
  });
  const proxyServer = await listen(proxy);

  try {
    const result = await verifyEgressViaProxy({
      localProxyUrl: proxyServer.url,
      verificationUrl: "http://geo.example/lookup",
      expectedCountryCode: "US",
      timeoutMs: 1000,
      countryCodePath: "country_code"
    });

    assert.deepEqual(result, {
      ok: true,
      observedCountryCode: "US",
      observedIp: "198.51.100.7"
    });

    await assert.rejects(
      () => verifyEgressViaProxy({
        localProxyUrl: proxyServer.url,
        verificationUrl: "http://geo.example/lookup",
        expectedCountryCode: "GB",
        timeoutMs: 1000,
        countryCodePath: "country_code"
      }),
      /country mismatch/i
    );
  } finally {
    await proxyServer.close();
  }
});

test("supports an injected HTTPS egress transport for CONNECT-backed verification", async () => {
  const result = await verifyEgressViaProxy({
    localProxyUrl: "http://127.0.0.1:8788",
    verificationUrl: "https://geo.example/lookup",
    expectedCountryCode: "US",
    timeoutMs: 1000,
    countryCodePath: "country_code",
    httpsTransport: async ({ proxyUrl, targetUrl }) => {
      assert.equal(proxyUrl.href, "http://127.0.0.1:8788/");
      assert.equal(targetUrl.href, "https://geo.example/lookup");
      return JSON.stringify({ country_code: "US", ip: "198.51.100.8" });
    }
  });

  assert.deepEqual(result, {
    ok: true,
    observedCountryCode: "US",
    observedIp: "198.51.100.8"
  });
});

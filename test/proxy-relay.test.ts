import test from "node:test";
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { JsonLogger } from "../src/logger.js";
import { ProxyRelay } from "../src/proxy-relay.js";
import { WebshareCountryProvider } from "../src/webshare.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("logs a sanitized upstream CONNECT rejection status", async () => {
  const upstream = createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
        "Proxy-Authenticate: Basic realm=allocated-password\r\n\r\n"
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const warnings: string[] = [];
  const relay = new ProxyRelay(
    { host: "127.0.0.1", port: 0 },
    new JsonLogger({
      directory: "",
      retentionFiles: 0,
      stdout: () => undefined,
      stderr: (line) => warnings.push(line)
    })
  );
  await relay.start();
  await relay.updateUpstream(
    `http://allocated-user:allocated-password@127.0.0.1:${upstreamAddress.port}`
  );

  try {
    const relayUrl = new URL(relay.localProxyUrl);
    const response = await new Promise<string>((resolve, reject) => {
      const client = connect(Number(relayUrl.port), relayUrl.hostname);
      let data = "";
      client.on("connect", () => client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
      client.on("data", (chunk) => {
        data += chunk.toString("utf8");
      });
      client.on("end", () => resolve(data));
      client.on("error", reject);
    });

    assert.match(response, /502 Upstream CONNECT Failed/);
    assert.match(warnings.join("\n"), /proxy_upstream_connect_rejected/);
    assert.match(warnings.join("\n"), /statusCode.*407/);
    assert.doesNotMatch(warnings.join("\n"), /allocated-user|allocated-password|Proxy-Authenticate/);
  } finally {
    await relay.stop();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("sends exact allocated credentials in upstream Basic authentication", async () => {
  const username = "user%2F name:/é";
  const password = "pass%40 word:/é";
  let upstreamRequest = "";
  const upstream = createServer((socket) => {
    socket.once("data", (chunk) => {
      upstreamRequest = chunk.toString("utf8");
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const provider = new WebshareCountryProvider({
    apiKey: "api-key",
    mode: "backbone",
    proxyHost: "127.0.0.1",
    proxyPort: upstreamAddress.port,
    fetch: async () => jsonResponse({
      count: 1,
      next: null,
      results: [{
        id: "proxy-special",
        country_code: "US",
        valid: true,
        username,
        password
      }]
    })
  });
  const relay = new ProxyRelay(
    { host: "127.0.0.1", port: 0 },
    new JsonLogger({ directory: "", retentionFiles: 0, terminal: false })
  );
  await relay.start();
  await relay.updateUpstream(await provider.selectProxy("US"));

  try {
    const relayUrl = new URL(relay.localProxyUrl);
    await new Promise<void>((resolve, reject) => {
      const client = connect(Number(relayUrl.port), relayUrl.hostname);
      client.on("connect", () => client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
      client.on("data", () => undefined);
      client.on("end", resolve);
      client.on("error", reject);
    });

    const authorization = /^Proxy-Authorization:\s*Basic\s+([^\r\n]+)$/im.exec(upstreamRequest)?.[1];
    assert.ok(authorization);
    assert.equal(Buffer.from(authorization, "base64").toString("utf8"), `${username}:${password}`);
  } finally {
    await relay.stop();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

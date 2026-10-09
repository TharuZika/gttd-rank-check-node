import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { verifyEgressViaProxy } from "../src/egress.js";

test("wraps the CONNECT tunnel socket in TLS before sending an HTTPS verification request", async () => {
  let tlsConnectorCalled = false;
  const proxy = createServer((socket) => handleConnectThenHttp(socket));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await verifyEgressViaProxy({
      localProxyUrl: `http://127.0.0.1:${address.port}`,
      verificationUrl: "https://geo.example/lookup?format=json",
      expectedCountryCode: "US",
      timeoutMs: 1000,
      countryCodePath: "country_code",
      tlsConnector: (options, onSecureConnect) => {
        tlsConnectorCalled = true;
        assert.equal(options.servername, "geo.example");
        assert.equal(options.rejectUnauthorized, true);
        assert.ok(options.socket);
        setImmediate(onSecureConnect);
        return options.socket as TLSSocket;
      }
    });

    assert.equal(tlsConnectorCalled, true);
    assert.deepEqual(result, {
      ok: true,
      observedCountryCode: "US",
      observedIp: "198.51.100.44"
    });
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  }
});

function handleConnectThenHttp(socket: Socket): void {
  let phase: "connect" | "request" = "connect";
  let buffered = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (true) {
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const headers = buffered.subarray(0, headerEnd + 4).toString("utf8");
      buffered = buffered.subarray(headerEnd + 4);
      if (phase === "connect") {
        assert.match(headers, /^CONNECT geo\.example:443 HTTP\/1\.1/m);
        phase = "request";
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        continue;
      }

      assert.match(headers, /^GET \/lookup\?format=json HTTP\/1\.1/m);
      const body = JSON.stringify({ country_code: "US", ip: "198.51.100.44" });
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
      );
      return;
    }
  });
}

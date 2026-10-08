import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { formatStartupError, startService } from "../src/index.js";
import { AppError } from "../src/errors.js";
import { JsonLogger } from "../src/logger.js";
import type { AppConfig } from "../src/types.js";

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return `http://127.0.0.1:${(address as { port: number }).port}`;
}

function config(browserMcpUrl: string): AppConfig {
  return {
    apiToken: "t".repeat(32),
    gateway: { host: "127.0.0.1", port: 0 },
    proxyRelay: { host: "127.0.0.1", port: 0 },
    browserOs: { mcpUrl: new URL(browserMcpUrl), requestTimeoutMs: 1000 },
    proxyProvider: { upstreamUrlTemplate: "http://user-country-{country}:secret@example.proxy:8080" },
    egressVerification: {
      url: new URL("http://127.0.0.1/geo"),
      timeoutMs: 1000,
      countryCodePath: "country_code"
    },
    countries: [{ countryCode: "US", countryName: "United States" }],
    logging: { directory: "", retentionFiles: 0 }
  };
}

test("logs startup proxy, BrowserOS MCP, and gateway statuses once", async () => {
  const browser = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200);
    res.end("ok");
  });
  const browserUrl = await listen(browser);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logger = new JsonLogger({
    directory: "",
    retentionFiles: 0,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line)
  });
  const service = await startService(config(`${browserUrl}/mcp`), logger);

  try {
    const startupLogs = [...stdout, ...stderr].join("\n");
    assert.equal(stdout.filter((line) => line.includes("proxy_relay_status")).length, 1);
    assert.equal(stdout.filter((line) => line.includes("browseros_mcp_status")).length, 1);
    assert.equal(stdout.filter((line) => line.includes("gateway_up")).length, 1);
    assert.match(startupLogs, /proxy_relay_status .*up/);
    assert.match(startupLogs, /browseros_mcp_status .*up/);

    const address = service.gateway.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const beforeBrowserStatusCount = stdout.filter((line) => line.includes("browseros_mcp_status")).length;
    const health = await fetch(`http://127.0.0.1:${(address as { port: number }).port}/health`);
    assert.equal(health.status, 200);
    assert.equal(stdout.filter((line) => line.includes("browseros_mcp_status")).length, beforeBrowserStatusCount);
  } finally {
    await service.stop();
    await new Promise<void>((resolve, reject) => browser.close((error) => (error ? reject(error) : resolve())));
  }
});

test("formats actionable startup errors without leaking credentials", () => {
  const missingConfig = new AppError(
    500,
    "config_not_found",
    "Configuration file not found. Create C:\\ProgramData\\Findrhost\\RankCheckNode\\config.json."
  );
  assert.match(formatStartupError(missingConfig), /config_not_found/);
  assert.match(formatStartupError(missingConfig), /ProgramData/);

  const secretFailure = new Error(
    "Failed for http://proxy-user:proxy-password@proxy.example:8080 with Authorization: Bearer private-token"
  );
  const formatted = formatStartupError(secretFailure);
  assert.doesNotMatch(formatted, /proxy-password|private-token/);
  assert.equal(formatted, "startup_failed: Rank-check node failed to start. Check configuration and port availability.");
});

test("releases the proxy relay when gateway startup fails", async () => {
  const browser = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200);
    res.end("ok");
  });
  const browserUrl = await listen(browser);
  const occupiedGateway = createServer();
  const gatewayUrl = await listen(occupiedGateway);
  const gatewayPort = Number(new URL(gatewayUrl).port);
  const relayReservation = createServer();
  const relayUrl = await listen(relayReservation);
  const relayPort = Number(new URL(relayUrl).port);
  await new Promise<void>((resolve, reject) => relayReservation.close((error) => error ? reject(error) : resolve()));

  const failedConfig = config(`${browserUrl}/mcp`);
  failedConfig.gateway.port = gatewayPort;
  failedConfig.proxyRelay.port = relayPort;
  const logger = new JsonLogger({ directory: "", retentionFiles: 0, terminal: false });

  try {
    await assert.rejects(startService(failedConfig, logger), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "EADDRINUSE");
      return true;
    });

    const relayProbe = createServer();
    await new Promise<void>((resolve, reject) => {
      relayProbe.once("error", reject);
      relayProbe.listen(relayPort, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => relayProbe.close((error) => error ? reject(error) : resolve()));
  } finally {
    await new Promise<void>((resolve, reject) => occupiedGateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => browser.close((error) => error ? reject(error) : resolve()));
  }
});

import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { BrowserMcpProxy } from "./browser-proxy.js";
import { createGatewayServer } from "./gateway.js";
import { loadConfig } from "./config.js";
import { verifyEgressViaProxy } from "./egress.js";
import { JsonLogger } from "./logger.js";
import { ProxyRelay } from "./proxy-relay.js";
import { ProxyStateManager } from "./proxy-state.js";
import type { AppConfig } from "./types.js";

export interface StartedService {
  gateway: Server;
  relay: ProxyRelay;
  browserProxy: BrowserMcpProxy;
  stop(): Promise<void>;
}

export async function startService(config: AppConfig, logger = new JsonLogger(config.logging)): Promise<StartedService> {
  const relay = new ProxyRelay(config.proxyRelay, logger);
  await relay.start();
  logger.info("proxy_relay_status", {
    status: "up",
    localProxyUrl: relay.localProxyUrl,
    upstreamConfigured: false
  });

  const browserProxy = new BrowserMcpProxy(config.browserOs, logger);
  const browserStatus = await browserProxy.checkReady();
  const browserLog = browserStatus.ok ? logger.info.bind(logger) : logger.warn.bind(logger);
  browserLog("browseros_mcp_status", {
    status: browserStatus.ok ? "up" : "down",
    mcpUrl: config.browserOs.mcpUrl.href,
    statusCode: browserStatus.statusCode,
    error: browserStatus.error
  });

  const proxyState = new ProxyStateManager({
    countries: config.countries,
    upstreamUrlTemplate: config.proxyProvider.upstreamUrlTemplate,
    relay,
    verifyEgress: ({ countryCode, localProxyUrl }) => verifyEgressViaProxy({
      localProxyUrl,
      verificationUrl: config.egressVerification.url.href,
      expectedCountryCode: countryCode,
      timeoutMs: config.egressVerification.timeoutMs,
      countryCodePath: config.egressVerification.countryCodePath
    })
  });

  const gateway = createGatewayServer({ config, proxyState, logger, browserProxy });
  await listen(gateway, config.gateway.host, config.gateway.port);
  const address = gateway.address();
  logger.info("gateway_up", {
    status: "up",
    gatewayHost: config.gateway.host,
    gatewayPort: address && typeof address === "object" ? address.port : config.gateway.port
  });

  return {
    gateway,
    relay,
    browserProxy,
    async stop(): Promise<void> {
      if (gateway.listening) {
        await new Promise<void>((resolve, reject) => {
          gateway.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await relay.stop();
    }
  };
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new JsonLogger(config.logging);
  const service = await startService(config, logger);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info("shutdown_requested", { signal });
      void service.stop()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error("shutdown_failed", { error: error instanceof Error ? error.message : String(error) });
          process.exit(1);
        });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

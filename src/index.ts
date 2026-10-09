import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { BrowserMcpProxy } from "./browser-proxy.js";
import { createGatewayServer } from "./gateway.js";
import { loadConfig } from "./config.js";
import { verifyEgressViaProxy } from "./egress.js";
import { AppError } from "./errors.js";
import { JsonLogger, sanitizeLogText } from "./logger.js";
import { ProxyRelay } from "./proxy-relay.js";
import { ProxyStateManager } from "./proxy-state.js";
import { WebshareCountryProvider } from "./webshare.js";
import type { AppConfig } from "./types.js";

export interface StartedService {
  gateway: Server;
  relay: ProxyRelay;
  browserProxy: BrowserMcpProxy;
  stop(): Promise<void>;
}

export async function startService(config: AppConfig, logger = new JsonLogger(config.logging)): Promise<StartedService> {
  const relay = new ProxyRelay(config.proxyRelay, logger);
  let gateway: Server | undefined;

  try {
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

    const countryProvider = config.webshare
      ? new WebshareCountryProvider({
        apiKey: config.webshare.apiKey,
        mode: config.webshare.mode,
        planId: config.webshare.planId,
        proxyHost: config.webshare.host,
        proxyPort: config.webshare.port,
        logger
      })
      : undefined;

    const proxyState = new ProxyStateManager({
      countries: config.countries,
      loadCountries: countryProvider ? () => countryProvider.listCountries() : undefined,
      upstreamUrlTemplate: config.proxyProvider.upstreamUrlTemplate,
      resolveUpstreamProxy: countryProvider
        ? ({ countryCode }) => countryProvider.selectProxy(countryCode)
        : undefined,
      relay,
      logger,
      verifyEgress: ({ countryCode, localProxyUrl }) => verifyEgressViaProxy({
        localProxyUrl,
        verificationUrl: config.egressVerification.url.href,
        expectedCountryCode: countryCode,
        timeoutMs: config.egressVerification.timeoutMs,
        countryCodePath: config.egressVerification.countryCodePath
      })
    });

    gateway = createGatewayServer({ config, proxyState, logger, browserProxy });
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
        await closeServer(gateway);
        await relay.stop();
      }
    };
  } catch (error) {
    try {
      await closeServer(gateway);
    } catch (cleanupError) {
      logger.error("startup_cleanup_failed", {
        component: "gateway",
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      });
    }
    try {
      await relay.stop();
    } catch (cleanupError) {
      logger.error("startup_cleanup_failed", {
        component: "proxy_relay",
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      });
    }
    throw error;
  }
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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

export function formatStartupError(error: unknown): string {
  if (error instanceof AppError) {
    return `${error.code}: ${sanitizeLogText(error.message)}`;
  }
  return "startup_failed: Rank-check node failed to start. Check configuration and port availability.";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${new Date().toISOString()} ERROR ${formatStartupError(error)}\n`);
    process.exitCode = 1;
  });
}

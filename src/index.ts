import { createGatewayServer } from "./gateway.js";
import { loadConfig } from "./config.js";
import { verifyEgressViaProxy } from "./egress.js";
import { JsonLogger } from "./logger.js";
import { ProxyRelay } from "./proxy-relay.js";
import { ProxyStateManager } from "./proxy-state.js";

const config = loadConfig();
const logger = new JsonLogger(config.logging);
const relay = new ProxyRelay(config.proxyRelay, logger);

await relay.start();

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

const gateway = createGatewayServer({ config, proxyState, logger });

gateway.listen(config.gateway.port, config.gateway.host, () => {
  logger.info("gateway_started", {
    gatewayHost: config.gateway.host,
    gatewayPort: config.gateway.port,
    proxyRelay: relay.localProxyUrl,
    browserMcpUrl: config.browserOs.mcpUrl.href
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info("shutdown_requested", { signal });
    gateway.close(() => {
      void relay.stop().finally(() => process.exit(0));
    });
  });
}

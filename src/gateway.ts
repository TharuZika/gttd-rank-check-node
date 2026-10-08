import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { isAuthorized } from "./auth.js";
import { BrowserMcpProxy } from "./browser-proxy.js";
import { AppError, toAppError } from "./errors.js";
import type { JsonLogger } from "./logger.js";
import type { ProxyStateManager } from "./proxy-state.js";
import type { AppConfig } from "./types.js";

export interface GatewayOptions {
  config: AppConfig;
  proxyState: ProxyStateManager;
  logger: JsonLogger;
  browserProxy?: BrowserMcpProxy;
}

export function createGatewayServer(options: GatewayOptions): Server {
  const browserProxy = options.browserProxy ?? new BrowserMcpProxy(options.config.browserOs, options.logger);
  return createServer((req, res) => {
    void routeRequest(req, res, { ...options, browserProxy });
  });
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions & { browserProxy: BrowserMcpProxy }
): Promise<void> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let completed = false;
  res.once("finish", () => {
    completed = true;
    options.logger.info("request_completed", {
      requestId,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  res.once("close", () => {
    if (!completed) {
      options.logger.warn("request_aborted", {
        requestId,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      });
    }
  });

  options.logger.info("request_received", {
    requestId,
    method: req.method ?? "UNKNOWN",
    path: (req.url ?? "/").split("?", 1)[0] || "/"
  });

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "gttd-rank-check-node", requestId });
      return;
    }

    if (!isAuthorized(req.headers, options.config.apiToken)) {
      sendJson(res, 401, { error: "unauthorized", requestId });
      return;
    }

    if (req.method === "GET" && url.pathname === "/countries") {
      sendJson(res, 200, { countries: options.proxyState.listCountries() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/ready") {
      const snapshot = options.proxyState.snapshot();
      if (!options.proxyState.isReady()) {
        sendJson(res, 503, { ready: false, proxy: snapshot, browser: { ok: false, skipped: true }, requestId });
        return;
      }
      const browser = await options.browserProxy.checkReady();
      sendJson(res, browser.ok ? 200 : 503, { ready: browser.ok, proxy: snapshot, browser, requestId });
      return;
    }

    if (req.method === "GET" && url.pathname === "/proxy") {
      const country = url.searchParams.get("country");
      if (!country) {
        throw new AppError(400, "missing_country", "country query parameter is required");
      }
      const result = await options.proxyState.activateCountry(country);
      sendJson(res, 200, result);
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/browser") {
      if (!options.proxyState.isReady()) {
        sendJson(res, 503, { error: "proxy_not_ready", message: "Select and verify a proxy country before using BrowserOS", requestId });
        return;
      }
      options.browserProxy.forward(req, res);
      return;
    }

    if (url.pathname === "/browser") {
      sendJson(res, 405, { error: "method_not_allowed", requestId });
      return;
    }

    sendJson(res, 404, { error: "not_found", requestId });
  } catch (error) {
    const appError = toAppError(error);
    const log = appError.statusCode >= 500 ? options.logger.error.bind(options.logger) : options.logger.warn.bind(options.logger);
    log("gateway_request_failed", {
      requestId,
      statusCode: appError.statusCode,
      code: appError.code,
      message: appError.message
    });
    sendJson(res, appError.statusCode, {
      error: appError.code,
      message: appError.message,
      requestId
    });
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

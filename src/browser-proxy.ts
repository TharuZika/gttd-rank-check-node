import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonLogger } from "./logger.js";
import type { AppConfig } from "./types.js";

const HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export class BrowserMcpProxy {
  private readonly mcpUrl: URL;
  private readonly requestTimeoutMs: number;
  private readonly logger?: JsonLogger;

  constructor(config: AppConfig["browserOs"], logger?: JsonLogger) {
    this.mcpUrl = config.mcpUrl;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.logger = logger;
  }

  async checkReady(timeoutMs = Math.min(this.requestTimeoutMs, 1500)): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
    return new Promise((resolve) => {
      const request = selectRequest(this.mcpUrl);
      const req = request({
        method: "GET",
        protocol: this.mcpUrl.protocol,
        hostname: this.mcpUrl.hostname,
        port: this.mcpUrl.port,
        path: `${this.mcpUrl.pathname}${this.mcpUrl.search}`,
        timeout: timeoutMs
      }, (res) => {
        res.resume();
        resolve({ ok: isReadyStatus(res.statusCode), statusCode: res.statusCode });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, error: "timeout" });
      });
      req.on("error", (error) => resolve({ ok: false, error: error.message }));
      req.end();
    });
  }

  forward(req: IncomingMessage, res: ServerResponse): void {
    const request = selectRequest(this.mcpUrl);
    let completed = false;
    const upstreamReq = request({
      protocol: this.mcpUrl.protocol,
      hostname: this.mcpUrl.hostname,
      port: this.mcpUrl.port,
      method: req.method,
      path: `${this.mcpUrl.pathname}${this.mcpUrl.search}`,
      headers: forwardRequestHeaders(req.headers)
    }, (upstreamRes) => {
      completed = true;
      clearTimeout(timeout);
      res.writeHead(upstreamRes.statusCode ?? 502, forwardResponseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (error) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      this.logger?.error("browseros_request_failed", { error: error.message });
      if (!res.headersSent) {
        res.writeHead(503, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "browseros_unavailable", message: "BrowserOS MCP endpoint is unavailable" }));
    });

    const timeout = setTimeout(() => {
      if (completed) {
        return;
      }
      completed = true;
      upstreamReq.destroy();
      this.logger?.error("browseros_request_timeout", { timeoutMs: this.requestTimeoutMs });
      if (!res.headersSent) {
        res.writeHead(504, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "browseros_timeout", message: "BrowserOS MCP endpoint timed out before response headers" }));
    }, this.requestTimeoutMs);

    req.pipe(upstreamReq);
  }
}

function selectRequest(url: URL) {
  return url.protocol === "https:" ? httpsRequest : httpRequest;
}

function isReadyStatus(statusCode: number | undefined): boolean {
  return statusCode !== undefined && ((statusCode >= 200 && statusCode < 300) || statusCode === 405);
}

function forwardRequestHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const output = forwardHeaders(headers);
  delete output.authorization;
  return output;
}

function forwardResponseHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  return forwardHeaders(headers);
}

function forwardHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (HOP_HEADERS.has(lowerKey)) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

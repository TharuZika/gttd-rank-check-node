import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError } from "./errors.js";
import { parseEgressVerificationBody } from "./egress.js";
import type { JsonLogger } from "./logger.js";
import type { AppConfig, EgressVerificationResult } from "./types.js";

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

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BrowserEgressProbeOptions {
  verificationUrl: string;
  expectedCountryCode: string;
  countryCodePath: string;
  timeoutMs: number;
}

export interface BrowserMcpProxyOptions {
  fetch?: Fetch;
  probePollIntervalMs?: number;
}

export class BrowserMcpProxy {
  private readonly mcpUrl: URL;
  private readonly requestTimeoutMs: number;
  private readonly logger?: JsonLogger;
  private readonly fetch: Fetch;
  private readonly probePollIntervalMs: number;

  constructor(config: AppConfig["browserOs"], logger?: JsonLogger, options: BrowserMcpProxyOptions = {}) {
    this.mcpUrl = config.mcpUrl;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.logger = logger;
    this.fetch = options.fetch ?? fetch;
    this.probePollIntervalMs = options.probePollIntervalMs ?? 250;
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

  async verifyEgress(options: BrowserEgressProbeOptions): Promise<EgressVerificationResult> {
    let pageId: number | null = null;
    let closeToolName: string | undefined;
    try {
      await this.callMcp("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "gttd-rank-check-node", version: "1.0.0" }
      }, options.timeoutMs).catch(() => undefined);

      const toolsResult = await this.callMcp("tools/list", {}, options.timeoutMs);
      const tools = readTools(toolsResult);
      const openTool = pickTool(tools, [/^new_page$/i, /^new_hidden_page$/i]);
      const contentTool = pickTool(tools, [/^get_page_content$/i, /^take_enhanced_snapshot$/i, /^take_snapshot$/i]);
      const evaluateTool = pickTool(tools, [/^evaluate_script$/i]);
      const listTool = pickTool(tools, [/^list_pages$/i]);
      const closeTool = pickTool(tools, [/^close_page$/i]);
      closeToolName = closeTool?.name;

      if (!openTool || (!contentTool && !evaluateTool)) {
        throw new AppError(502, "browseros_probe_tools_missing", "BrowserOS MCP probe tools are unavailable");
      }

      const opened = await this.callMcp("tools/call", {
        name: openTool.name,
        arguments: openTool.name.toLowerCase() === "new_page"
          ? { url: options.verificationUrl, background: true, hidden: true }
          : { url: options.verificationUrl }
      }, options.timeoutMs);
      pageId = extractPageId(opened);
      if (pageId === null) {
        throw new AppError(502, "browseros_probe_malformed_response", "BrowserOS MCP did not return a page identifier");
      }

      if (listTool) {
        await this.waitForPage(pageId, options.timeoutMs);
      }

      const content = evaluateTool
        ? await this.callMcp("tools/call", {
          name: evaluateTool.name,
          arguments: {
            page: pageId,
            expression: "(() => document.body ? document.body.innerText : '')()"
          }
        }, options.timeoutMs)
        : await this.callMcp("tools/call", {
          name: contentTool!.name,
          arguments: contentTool!.name.toLowerCase() === "get_page_content"
            ? { page: pageId, viewportOnly: false, includeLinks: false, includeImages: false }
            : { page: pageId }
        }, options.timeoutMs);

      const body = extractMcpBody(content);
      try {
        return parseEgressVerificationBody(
          body,
          options.expectedCountryCode,
          options.countryCodePath,
          "browseros_egress"
        );
      } catch (error) {
        if (error instanceof AppError && error.code === "browseros_egress_invalid_response") {
          throw new AppError(502, "browseros_probe_malformed_response", "BrowserOS egress response was not valid JSON");
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(502, "browseros_egress_failed", "BrowserOS egress verification failed");
    } finally {
      if (pageId !== null && closeToolName) {
        try {
          await this.callMcp("tools/call", {
            name: closeToolName,
            arguments: { page: pageId }
          }, Math.min(options.timeoutMs, this.requestTimeoutMs));
        } catch (error) {
          this.logger?.warn("browseros_probe_cleanup_failed", {
            pageId,
            error: error instanceof AppError ? error.code : "browseros_cleanup_failed"
          });
        }
      }
    }
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

  private async callMcp(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    let response: Response;
    let responseText = "";
    try {
      response = await this.fetch(this.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          method,
          params
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      responseText = await response.text();
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new AppError(504, "browseros_probe_timeout", "BrowserOS egress verification timed out");
      }
      throw new AppError(502, "browseros_probe_unavailable", "BrowserOS MCP endpoint is unavailable");
    }

    if (!response.ok) {
      throw new AppError(502, "browseros_probe_http_error", "BrowserOS MCP probe request failed", {
        statusCode: response.status
      });
    }

    const payload = parseMcpResponse(responseText);
    if (payload.error) {
      throw new AppError(502, "browseros_probe_failed", "BrowserOS MCP probe call failed");
    }
    return payload.result;
  }

  private async waitForPage(pageId: number, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      const result = await this.callMcp("tools/call", {
        name: "list_pages",
        arguments: {}
      }, remainingMs);
      const pages = readStructuredContent(result)?.pages;
      const page = Array.isArray(pages)
        ? pages.find((candidate) => Number(candidate?.pageId) === pageId)
        : undefined;
      if (page && (!page.isLoading && Number(page.loadProgress ?? 1) >= 0.9)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.probePollIntervalMs, timeoutMs)));
    }
    throw new AppError(504, "browseros_probe_timeout", "BrowserOS verification page did not finish loading");
  }
}

interface McpPayload {
  result?: unknown;
  error?: unknown;
}

function parseMcpResponse(value: string): McpPayload {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AppError(502, "browseros_probe_malformed_response", "BrowserOS MCP returned an empty response");
  }
  const candidate = trimmed.startsWith("{")
    ? trimmed
    : trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("data:")).at(-1)?.replace(/^data:\s*/, "");
  if (!candidate) {
    throw new AppError(502, "browseros_probe_malformed_response", "BrowserOS MCP returned an invalid response");
  }
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as McpPayload;
  } catch {
    throw new AppError(502, "browseros_probe_malformed_response", "BrowserOS MCP returned an invalid response");
  }
}

function readTools(value: unknown): Array<{ name: string }> {
  const tools = readStructuredContent(value)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool): tool is { name: string } => Boolean(tool && typeof tool === "object" && typeof tool.name === "string"));
}

function pickTool(tools: Array<{ name: string }>, patterns: RegExp[]): { name: string } | undefined {
  return tools.find((tool) => patterns.some((pattern) => pattern.test(tool.name)));
}

function readStructuredContent(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, any>;
    if (record.structuredContent && typeof record.structuredContent === "object") {
      return record.structuredContent;
    }
    return record;
  }
  return {};
}

function extractPageId(value: unknown): number | null {
  const structured = readStructuredContent(value);
  const direct = structured.pageId ?? structured.page?.pageId;
  if (direct !== undefined && direct !== null && Number.isFinite(Number(direct))) {
    return Number(direct);
  }
  const text = extractMcpBody(value);
  const match = text.match(/Page ID:\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function extractMcpBody(value: unknown): string {
  const structured = readStructuredContent(value);
  const candidates = [
    structured.text,
    structured.value,
    structured.content,
    structured.snapshot,
    (value as { text?: unknown } | null)?.text,
    (value as { content?: unknown } | null)?.content
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (Array.isArray(candidate)) {
      const text = candidate.map((item) => typeof item === "string" ? item : item?.text || item?.content || "").join("\n");
      if (text.trim()) return text;
    }
  }
  return typeof value === "string" ? value : JSON.stringify(value);
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

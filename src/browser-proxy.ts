import { appendFileSync, mkdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
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
const MCP_PROTOCOL_VERSION = "2025-06-18";

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
  diagnosticDirectory?: string;
}

export class BrowserMcpProxy {
  private readonly mcpUrl: URL;
  private readonly requestTimeoutMs: number;
  private readonly logger?: JsonLogger;
  private readonly fetch: Fetch;
  private readonly probePollIntervalMs: number;
  private readonly diagnosticDirectory?: string;

  constructor(config: AppConfig["browserOs"], logger?: JsonLogger, options: BrowserMcpProxyOptions = {}) {
    // BrowserOS returns evaluate() output as structuredContent only when
    // structured mode is enabled. Without it, the response is an
    // untrusted-text wrapper and cannot be parsed as the verification JSON.
    const mcpUrl = new URL(config.mcpUrl.href);
    mcpUrl.searchParams.set("structured", "1");
    this.mcpUrl = mcpUrl;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.logger = logger;
    this.fetch = options.fetch ?? fetch;
    this.probePollIntervalMs = options.probePollIntervalMs ?? 250;
    this.diagnosticDirectory = options.diagnosticDirectory;
  }

  async checkReady(timeoutMs = Math.min(this.requestTimeoutMs, 1500)): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
    let sessionId: string | undefined;
    try {
      const initialized = await this.requestMcp("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "gttd-rank-check-node", version: "1.0.0" }
      }, timeoutMs);
      sessionId = initialized.sessionId;
      if (sessionId) {
        await this.sendMcpNotification("notifications/initialized", {}, timeoutMs, sessionId);
      }
      return { ok: true, statusCode: initialized.statusCode };
    } catch (error) {
      if (error instanceof AppError) {
        const statusCode = typeof error.details?.statusCode === "number" ? error.details.statusCode : undefined;
        return { ok: false, statusCode, error: error.code };
      }
      return { ok: false, error: "browseros_probe_unavailable" };
    } finally {
      if (sessionId) {
        try {
          await this.closeMcpSession(sessionId, timeoutMs);
        } catch {
          // Readiness is already determined by the handshake; cleanup is best effort.
        }
      }
    }
  }

  async verifyEgress(options: BrowserEgressProbeOptions): Promise<EgressVerificationResult> {
    let pageId: number | null = null;
    let closeToolName: string | undefined;
    let sessionId: string | undefined;
    try {
      const initialized = await this.requestMcp("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "gttd-rank-check-node", version: "1.0.0" }
      }, options.timeoutMs);
      sessionId = initialized.sessionId;
      if (sessionId) {
        await this.sendMcpNotification("notifications/initialized", {}, options.timeoutMs, sessionId);
      }

      const toolsResult = await this.callMcp("tools/list", {}, options.timeoutMs, sessionId);
      const tools = readTools(toolsResult);
      const openTool = pickTool(tools, [/^new_page$/i, /^new_hidden_page$/i, /^tabs$/i]);
      const contentTool = pickTool(tools, [/^get_page_content$/i, /^take_enhanced_snapshot$/i, /^take_snapshot$/i, /^read$/i]);
      const evaluateTool = pickTool(tools, [/^evaluate_script$/i, /^evaluate$/i]);
      const listTool = pickTool(tools, [/^list_pages$/i, /^tabs$/i]);
      const closeTool = pickTool(tools, [/^close_page$/i, /^tabs$/i]);
      closeToolName = closeTool?.name;

      if (!openTool || (!contentTool && !evaluateTool)) {
        throw new AppError(502, "browseros_probe_tools_missing", "BrowserOS MCP probe tools are unavailable");
      }

      const opened = await this.callMcp("tools/call", {
        name: openTool.name,
        arguments: openTool.name.toLowerCase() === "tabs"
          ? { action: "new", url: options.verificationUrl, background: true }
          : openTool.name.toLowerCase() === "new_page"
          ? { url: options.verificationUrl, background: true, hidden: true }
          : { url: options.verificationUrl }
      }, options.timeoutMs, sessionId);
      pageId = extractPageId(opened);
      if (pageId === null) {
        throw new AppError(502, "browseros_probe_malformed_response", "BrowserOS MCP did not return a page identifier");
      }

      if (listTool && listTool.name.toLowerCase() !== "tabs") {
        await this.waitForPage(pageId, listTool, options.timeoutMs, sessionId);
      }

      const content = evaluateTool
        ? await this.callMcp("tools/call", {
          name: evaluateTool.name,
          arguments: evaluateTool.name.toLowerCase() === "evaluate"
            ? {
              page: pageId,
              code: modernPageBodyScript(options.timeoutMs),
              timeout: Math.min(options.timeoutMs, 30000)
            }
            : {
              page: pageId,
              expression: "(() => document.body ? document.body.innerText : '')()"
            }
        }, options.timeoutMs, sessionId)
        : await this.callMcp("tools/call", {
          name: contentTool!.name,
          arguments: contentTool!.name.toLowerCase() === "read"
            ? { page: pageId, format: "text" }
            : contentTool!.name.toLowerCase() === "get_page_content"
              ? { page: pageId, viewportOnly: false, includeLinks: false, includeImages: false }
              : { page: pageId }
        }, options.timeoutMs, sessionId);

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
            arguments: closeToolName.toLowerCase() === "tabs"
              ? { action: "close", page: pageId }
              : { page: pageId }
          }, Math.min(options.timeoutMs, this.requestTimeoutMs), sessionId);
        } catch (error) {
          this.logger?.warn("browseros_probe_cleanup_failed", {
            pageId,
            error: error instanceof AppError ? error.code : "browseros_cleanup_failed"
          });
        }
      }
      if (sessionId) {
        try {
          await this.closeMcpSession(sessionId, Math.min(options.timeoutMs, this.requestTimeoutMs));
        } catch (error) {
          this.logger?.warn("browseros_probe_session_cleanup_failed", {
            error: error instanceof AppError ? error.code : "browseros_session_cleanup_failed"
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

  private async callMcp(method: string, params: Record<string, unknown>, timeoutMs: number, sessionId?: string): Promise<unknown> {
    const response = await this.requestMcp(method, params, timeoutMs, sessionId);
    if (response.payload.error) {
      throw new AppError(502, "browseros_probe_failed", "BrowserOS MCP probe call failed", {
        mcpMethod: method
      });
    }
    return response.payload.result;
  }

  private async requestMcp(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    sessionId?: string,
    notification = false
  ): Promise<{ payload: McpPayload; sessionId?: string; statusCode: number }> {
    let response: Response;
    let responseText = "";
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      };
      if (sessionId) {
        headers["mcp-session-id"] = sessionId;
        headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION;
      }
      const message: Record<string, unknown> = {
        jsonrpc: "2.0",
        method,
        params
      };
      if (!notification) {
        message.id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      }
      response = await this.fetch(this.mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs)
      });
      responseText = await response.text();
      this.writeMcpResponseDiagnostic(method, response.status, responseText);
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new AppError(504, "browseros_probe_timeout", "BrowserOS egress verification timed out");
      }
      throw new AppError(502, "browseros_probe_unavailable", "BrowserOS MCP endpoint is unavailable");
    }

    if (!response.ok) {
      throw new AppError(502, "browseros_probe_http_error", "BrowserOS MCP probe request failed", {
        statusCode: response.status,
        mcpMethod: method
      });
    }

    return {
      payload: responseText.trim() ? parseMcpResponse(responseText) : {},
      sessionId: response.headers.get("mcp-session-id") ?? sessionId,
      statusCode: response.status
    };
  }

  private async sendMcpNotification(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    sessionId: string
  ): Promise<void> {
    await this.requestMcp(method, params, timeoutMs, sessionId, true);
  }

  private async closeMcpSession(sessionId: string, timeoutMs: number): Promise<void> {
    let response: Response;
    try {
      response = await this.fetch(this.mcpUrl, {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
          "mcp-protocol-version": MCP_PROTOCOL_VERSION
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new AppError(503, "browseros_session_cleanup_failed", "BrowserOS MCP session cleanup failed");
    }

    if (!response.ok && response.status !== 404) {
      throw new AppError(503, "browseros_session_cleanup_failed", "BrowserOS MCP session cleanup failed", {
        statusCode: response.status
      });
    }
  }

  private writeMcpResponseDiagnostic(method: string, statusCode: number, responseText: string): void {
    if (!this.diagnosticDirectory) {
      return;
    }
    try {
      mkdirSync(this.diagnosticDirectory, { recursive: true });
      appendFileSync(join(this.diagnosticDirectory, "browseros-mcp-responses.txt"), `${JSON.stringify({
        timestamp: new Date().toISOString(),
        method,
        statusCode,
        response: sanitizeBrowserDiagnosticText(responseText)
      })}\n`, "utf8");
    } catch {
      // Diagnostics must never change proxy readiness or fail an MCP request.
    }
  }

  private async waitForPage(pageId: number, listTool: { name: string }, timeoutMs: number, sessionId?: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      const result = await this.callMcp("tools/call", {
        name: listTool.name,
        arguments: listTool.name.toLowerCase() === "tabs" ? { action: "list" } : {}
      }, remainingMs, sessionId);
      const pages = readStructuredContent(result)?.pages;
      const page = Array.isArray(pages)
        ? pages.find((candidate) => pageIdentifier(candidate) === pageId)
        : undefined;
      if (page && (listTool.name.toLowerCase() === "tabs" || (!page.isLoading && Number(page.loadProgress ?? 1) >= 0.9))) {
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

interface McpTool {
  name: string;
  inputSchema?: unknown;
}

function readTools(value: unknown): McpTool[] {
  const tools = readStructuredContent(value)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool): tool is McpTool => Boolean(tool && typeof tool === "object" && typeof tool.name === "string"));
}

function pickTool(tools: McpTool[], patterns: RegExp[]): McpTool | undefined {
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
  const direct = pageIdentifier(structured);
  if (direct !== undefined && direct !== null && Number.isFinite(Number(direct))) {
    return Number(direct);
  }
  const text = extractMcpBody(value);
  const match = text.match(/(?:Page ID|opened page)[:\s]+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function pageIdentifier(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const page = record.page;
  const candidates = [
    record.pageId,
    typeof page === "object" && page !== null ? (page as Record<string, unknown>).pageId : undefined,
    typeof page === "object" && page !== null ? (page as Record<string, unknown>).id : undefined,
    typeof page === "number" || typeof page === "string" ? page : undefined
  ];
  const candidate = candidates.find((item) => item !== undefined && item !== null && Number.isFinite(Number(item)));
  return candidate === undefined ? undefined : Number(candidate);
}

function modernPageBodyScript(timeoutMs: number): string {
  const waitBudgetMs = Math.max(100, timeoutMs - 250);
  return [
    `const deadline = Date.now() + ${waitBudgetMs};`,
    "while (Date.now() < deadline) {",
    "  const text = document.body?.innerText?.trim() ?? '';",
    "  if (text) return text;",
    "  await new Promise((resolve) => setTimeout(resolve, 100));",
    "}",
    "return document.body?.innerText ?? '';"
  ].join("\\n");
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
    if (typeof candidate === "string" && candidate.trim()) return unwrapBrowserOsContent(candidate);
    if (Array.isArray(candidate)) {
      const text = candidate.map((item) => typeof item === "string" ? item : item?.text || item?.content || "").join("\n");
      if (text.trim()) return unwrapBrowserOsContent(text);
    }
    if (candidate && typeof candidate === "object") {
      const text = JSON.stringify(candidate);
      if (text.trim()) return text;
    }
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function unwrapBrowserOsContent(value: string): string {
  const match = value.match(/^\s*\[UNTRUSTED_PAGE_CONTENT[^\]]*\][^\r\n]*\r?\n([\s\S]*?)\r?\n\[END_UNTRUSTED_PAGE_CONTENT[^\]]*\]\s*$/i);
  return match?.[1] ?? value;
}

function sanitizeBrowserDiagnosticText(value: string): string {
  return value
    .replace(/\b(?:https?|socks5):\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;}]+/gi, "$1****")
    .replace(/((?:api[_-]?(?:key|token)|token|password|secret|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1****");
}

function selectRequest(url: URL) {
  return url.protocol === "https:" ? httpsRequest : httpRequest;
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

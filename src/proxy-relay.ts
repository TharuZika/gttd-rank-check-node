import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { AppError } from "./errors.js";
import type { JsonLogger } from "./logger.js";
import type { LocalEndpoint } from "./types.js";

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const UPSTREAM_TIMEOUT_MS = 15000;

export class ProxyRelay {
  private readonly endpoint: LocalEndpoint;
  private readonly logger: JsonLogger;
  private readonly server: Server;
  private readonly activeSockets = new Set<Duplex>();
  private upstream?: URL;
  private boundPort?: number;

  constructor(endpoint: LocalEndpoint, logger: JsonLogger) {
    this.endpoint = endpoint;
    this.logger = logger;
    this.server = createServer((req, res) => this.handleHttpRequest(req, res));
    this.server.on("connect", (req, socket, head) => this.handleConnect(req, socket, head));
  }

  get localProxyUrl(): string {
    const port = this.boundPort ?? this.endpoint.port;
    return `http://${this.endpoint.host}:${port}`;
  }

  async start(): Promise<void> {
    if (this.server.listening) {
      return;
    }
    await new Promise<void>((resolve) => this.server.listen(this.endpoint.port, this.endpoint.host, resolve));
    const address = this.server.address();
    if (address && typeof address === "object") {
      this.boundPort = address.port;
    }
  }

  async stop(): Promise<void> {
    this.closeActiveTunnels();
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  async updateUpstream(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") {
      throw new AppError(400, "unsupported_proxy_protocol", "Only HTTP upstream proxy URLs are supported");
    }
    this.upstream = parsed;
  }

  closeActiveTunnels(): void {
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();
  }

  private handleHttpRequest(clientReq: IncomingMessage, clientRes: ServerResponse): void {
    if (!this.upstream) {
      clientRes.writeHead(503, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "proxy_not_ready" }));
      return;
    }

    const headers = copyForwardHeaders(clientReq.headers);
    addProxyAuthorization(headers, this.upstream);
    const upstreamReq = httpRequest({
      host: this.upstream.hostname,
      port: Number(this.upstream.port || 80),
      method: clientReq.method,
      path: clientReq.url,
      headers
    }, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, copyForwardHeaders(upstreamRes.headers));
      upstreamRes.pipe(clientRes);
    });

    upstreamReq.on("socket", (socket) => this.trackSocket(socket));
    upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstreamReq.destroy(new AppError(504, "upstream_proxy_timeout", "Upstream proxy timed out"));
    });
    upstreamReq.on("error", (error) => {
      this.logger.warn("proxy_relay_http_error", { error: error.message });
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "application/json" });
      }
      clientRes.end(JSON.stringify({ error: "upstream_proxy_error" }));
    });

    clientReq.pipe(upstreamReq);
  }

  private handleConnect(clientReq: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    if (!this.upstream) {
      clientSocket.end("HTTP/1.1 503 Proxy Not Ready\r\n\r\n");
      return;
    }

    const upstream = this.upstream;
    const upstreamSocket = netConnect(Number(upstream.port || 80), upstream.hostname);
    upstreamSocket.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      clientSocket.end("HTTP/1.1 504 Upstream Proxy Timeout\r\n\r\n");
      upstreamSocket.destroy();
    });
    this.trackSocket(clientSocket);
    this.trackSocket(upstreamSocket);

    upstreamSocket.once("connect", () => {
      const auth = proxyAuthorizationHeader(upstream);
      upstreamSocket.write(`CONNECT ${clientReq.url} HTTP/1.1\r\n`);
      upstreamSocket.write(`Host: ${clientReq.url}\r\n`);
      if (auth) {
        upstreamSocket.write(`Proxy-Authorization: ${auth}\r\n`);
      }
      upstreamSocket.write("\r\n");
    });

    let responseBuffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      upstreamSocket.off("data", onData);
      const statusLine = responseBuffer.subarray(0, responseBuffer.indexOf("\r\n")).toString("utf8");
      const success = /^HTTP\/1\.[01] 2\d\d/i.test(statusLine);
      if (!success) {
        clientSocket.end(`HTTP/1.1 502 Upstream CONNECT Failed\r\n\r\n`);
        upstreamSocket.destroy();
        return;
      }

      const extra = responseBuffer.subarray(headerEnd + 4);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      if (extra.length > 0) {
        clientSocket.write(extra);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      upstreamSocket.setTimeout(0);
    };

    upstreamSocket.on("data", onData);
    upstreamSocket.on("error", () => clientSocket.end("HTTP/1.1 502 Upstream Proxy Error\r\n\r\n"));
    clientSocket.on("error", () => upstreamSocket.destroy());
  }

  private trackSocket(socket: Duplex): void {
    this.activeSockets.add(socket);
    socket.once("close", () => this.activeSockets.delete(socket));
  }
}

function copyForwardHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function addProxyAuthorization(headers: Record<string, string | string[]>, upstream: URL): void {
  const auth = proxyAuthorizationHeader(upstream);
  if (auth) {
    headers["proxy-authorization"] = auth;
  }
}

function proxyAuthorizationHeader(upstream: URL): string | undefined {
  if (!upstream.username && !upstream.password) {
    return undefined;
  }
  const credentials = `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

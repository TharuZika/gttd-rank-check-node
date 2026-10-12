import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { AppError } from "./errors.js";
import type { EgressVerificationResult } from "./types.js";

export interface HttpsEgressTransportRequest {
  proxyUrl: URL;
  targetUrl: URL;
  timeoutMs: number;
  tlsRejectUnauthorized: boolean;
}

export type HttpsEgressTransport = (request: HttpsEgressTransportRequest) => Promise<string>;
export type TlsConnector = (options: ConnectionOptions, secureConnectListener: () => void) => TLSSocket;

export interface VerifyEgressViaProxyOptions {
  localProxyUrl: string;
  verificationUrl: string;
  expectedCountryCode: string;
  timeoutMs: number;
  countryCodePath: string;
  tlsRejectUnauthorized?: boolean;
  httpsTransport?: HttpsEgressTransport;
  tlsConnector?: TlsConnector;
}

const EGRESS_USER_AGENT = "gttd-rank-check-node/1.0";
const MAX_RETRY_AFTER_MS = 10_000;

export async function verifyEgressViaProxy(options: VerifyEgressViaProxyOptions): Promise<EgressVerificationResult> {
  const verificationUrl = new URL(options.verificationUrl);
  const proxyUrl = new URL(options.localProxyUrl);
  const httpsRequestOptions = {
    proxyUrl,
    targetUrl: verificationUrl,
    timeoutMs: options.timeoutMs,
    tlsRejectUnauthorized: options.tlsRejectUnauthorized ?? true
  };
  const body = verificationUrl.protocol === "https:"
    ? await (options.httpsTransport
      ? options.httpsTransport(httpsRequestOptions)
      : requestHttpsViaProxy(httpsRequestOptions, options.tlsConnector ?? tlsConnect))
    : await requestHttpViaProxy(proxyUrl, verificationUrl, options.timeoutMs);

  return parseEgressVerificationBody(body, options.expectedCountryCode, options.countryCodePath);
}

function createEgressHttpError(
  targetUrl: URL,
  statusCode: number | undefined,
  retryAfterHeader: string | string[] | undefined
): AppError {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  return new AppError(
    502,
    statusCode === 429 ? "egress_rate_limited" : "egress_http_error",
    "Egress verification failed",
    {
      statusCode,
      verificationHost: targetUrl.hostname,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs })
    }
  );
}

function parseRetryAfterMs(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;

  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, Math.round(seconds * 1000)), MAX_RETRY_AFTER_MS);
  }

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - Date.now()), MAX_RETRY_AFTER_MS);
}

export function parseEgressVerificationBody(
  body: string,
  expectedCountryCode: string,
  countryCodePath: string,
  errorPrefix = "egress"
): EgressVerificationResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new AppError(502, `${errorPrefix}_invalid_response`, "Egress verification did not return JSON");
  }

  const observedCountryCode = String(readPath(payload, countryCodePath) ?? "").toUpperCase();
  const observedIp = String(readPath(payload, "ip") ?? readPath(payload, "query") ?? readPath(payload, "origin") ?? "");
  if (observedCountryCode !== expectedCountryCode) {
    throw new AppError(502, `${errorPrefix}_country_mismatch`, "Egress country mismatch", {
      expectedCountryCode,
      observedCountryCode
    });
  }

  return {
    ok: true,
    observedCountryCode,
    observedIp: observedIp || undefined
  };
}

function requestHttpViaProxy(proxyUrl: URL, targetUrl: URL, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port || 80),
      method: "GET",
      path: targetUrl.href,
      headers: {
        host: targetUrl.host,
        accept: "application/json",
        "user-agent": EGRESS_USER_AGENT
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) {
          reject(createEgressHttpError(targetUrl, res.statusCode, res.headers["retry-after"]));
          return;
        }
        resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new AppError(504, "egress_timeout", "Egress verification timed out")));
    req.on("error", reject);
    req.end();
  });
}

function requestHttpsViaProxy(options: HttpsEgressTransportRequest, tlsConnector: TlsConnector): Promise<string> {
  return openConnectTunnel(options.proxyUrl, options.targetUrl, options.timeoutMs)
    .then((socket) => openTlsTunnel(
      socket,
      options.targetUrl,
      options.timeoutMs,
      options.tlsRejectUnauthorized,
      tlsConnector
    ))
    .then((socket) => requestHttpsOverTunnel(socket, options.targetUrl, options.timeoutMs));
}

function openConnectTunnel(proxyUrl: URL, targetUrl: URL, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const proxySocket = netConnect(Number(proxyUrl.port || 80), proxyUrl.hostname);
    const timeout = setTimeout(() => {
      proxySocket.destroy(new AppError(504, "egress_timeout", "Egress verification timed out"));
    }, timeoutMs);

    proxySocket.once("connect", () => {
      proxySocket.write(`CONNECT ${targetUrl.hostname}:${targetUrl.port || 443} HTTP/1.1\r\n`);
      proxySocket.write(`Host: ${targetUrl.hostname}:${targetUrl.port || 443}\r\n\r\n`);
    });

    let connectBuffer = Buffer.alloc(0);
    proxySocket.on("data", function onConnectData(chunk: Buffer) {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const headerEnd = connectBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      proxySocket.off("data", onConnectData);
      const statusLine = connectBuffer.subarray(0, connectBuffer.indexOf("\r\n")).toString("utf8");
      if (!/^HTTP\/1\.[01] 2\d\d/i.test(statusLine)) {
        clearTimeout(timeout);
        proxySocket.destroy();
        reject(new AppError(502, "egress_connect_failed", "Egress proxy CONNECT failed"));
        return;
      }

      clearTimeout(timeout);
      resolve(proxySocket);
    });
    proxySocket.on("error", reject);
  });
}

function openTlsTunnel(
  socket: Socket,
  targetUrl: URL,
  timeoutMs: number,
  tlsRejectUnauthorized: boolean,
  tlsConnector: TlsConnector
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    let tlsSocket: TLSSocket;
    const timeout = setTimeout(() => {
      tlsSocket.destroy(new AppError(504, "egress_timeout", "Egress TLS handshake timed out"));
    }, timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    const onSecureConnect = () => {
      clearTimeout(timeout);
      tlsSocket.off("error", onError);
      resolve(tlsSocket);
    };

    try {
      tlsSocket = tlsConnector({
        socket,
        servername: targetUrl.hostname,
        rejectUnauthorized: tlsRejectUnauthorized
      }, onSecureConnect);
      tlsSocket.once("error", onError);
    } catch (error) {
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    }
  });
}

function requestHttpsOverTunnel(socket: TLSSocket, targetUrl: URL, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const agent = new HttpAgent({ keepAlive: false });
    agent.createConnection = () => socket;
    const req = httpRequest({
      hostname: targetUrl.hostname,
      port: Number(targetUrl.port || 443),
      method: "GET",
      path: `${targetUrl.pathname}${targetUrl.search}` || "/",
      headers: {
        accept: "application/json",
        host: targetUrl.host,
        "user-agent": EGRESS_USER_AGENT
      },
      agent,
      timeout: timeoutMs
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) {
          agent.destroy();
          reject(createEgressHttpError(targetUrl, res.statusCode, res.headers["retry-after"]));
          return;
        }
        agent.destroy();
        resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new AppError(504, "egress_timeout", "Egress verification timed out")));
    req.on("error", (error) => {
      agent.destroy();
      reject(error);
    });
    req.end();
  });
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}

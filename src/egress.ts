import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { AppError } from "./errors.js";
import type { EgressVerificationResult } from "./types.js";

export interface HttpsEgressTransportRequest {
  proxyUrl: URL;
  targetUrl: URL;
  timeoutMs: number;
  tlsRejectUnauthorized: boolean;
}

export type HttpsEgressTransport = (request: HttpsEgressTransportRequest) => Promise<string>;

export interface VerifyEgressViaProxyOptions {
  localProxyUrl: string;
  verificationUrl: string;
  expectedCountryCode: string;
  timeoutMs: number;
  countryCodePath: string;
  tlsRejectUnauthorized?: boolean;
  httpsTransport?: HttpsEgressTransport;
}

export async function verifyEgressViaProxy(options: VerifyEgressViaProxyOptions): Promise<EgressVerificationResult> {
  const verificationUrl = new URL(options.verificationUrl);
  const proxyUrl = new URL(options.localProxyUrl);
  const body = verificationUrl.protocol === "https:"
    ? await (options.httpsTransport ?? requestHttpsViaProxy)({
      proxyUrl,
      targetUrl: verificationUrl,
      timeoutMs: options.timeoutMs,
      tlsRejectUnauthorized: options.tlsRejectUnauthorized ?? true
    })
    : await requestHttpViaProxy(proxyUrl, verificationUrl, options.timeoutMs);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new AppError(502, "egress_invalid_response", "Egress verification did not return JSON");
  }

  const observedCountryCode = String(readPath(payload, options.countryCodePath) ?? "").toUpperCase();
  const observedIp = String(readPath(payload, "ip") ?? readPath(payload, "query") ?? readPath(payload, "origin") ?? "");
  if (observedCountryCode !== options.expectedCountryCode) {
    throw new AppError(502, "egress_country_mismatch", "Egress country mismatch", {
      expectedCountryCode: options.expectedCountryCode,
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
        accept: "application/json"
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) {
          reject(new AppError(502, "egress_http_error", "Egress verification failed", { statusCode: res.statusCode }));
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

function requestHttpsViaProxy(options: HttpsEgressTransportRequest): Promise<string> {
  return openConnectTunnel(options.proxyUrl, options.targetUrl, options.timeoutMs)
    .then((socket) => requestHttpsOverTunnel(socket, options.targetUrl, options.timeoutMs, options.tlsRejectUnauthorized));
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

function requestHttpsOverTunnel(socket: Socket, targetUrl: URL, timeoutMs: number, tlsRejectUnauthorized: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname: targetUrl.hostname,
      port: Number(targetUrl.port || 443),
      method: "GET",
      path: `${targetUrl.pathname}${targetUrl.search}` || "/",
      headers: {
        accept: "application/json",
        host: targetUrl.host
      },
      createConnection: () => socket,
      servername: targetUrl.hostname,
      rejectUnauthorized: tlsRejectUnauthorized,
      timeout: timeoutMs
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) {
          reject(new AppError(502, "egress_http_error", "Egress verification failed", { statusCode: res.statusCode }));
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

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}

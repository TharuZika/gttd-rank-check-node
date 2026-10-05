import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export function isAuthorized(headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>, apiToken: string): boolean {
  const authorization = headers.authorization;
  if (Array.isArray(authorization) || typeof authorization !== "string") {
    return false;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }

  const providedDigest = digest(match[1]);
  const expectedDigest = digest(apiToken);
  return timingSafeEqual(providedDigest, expectedDigest);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

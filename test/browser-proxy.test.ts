import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserMcpProxy } from "../src/browser-proxy.js";
import { AppError } from "../src/errors.js";

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${(address as { port: number }).port}/mcp`;
}

function proxy(url: string, fetchImpl?: typeof fetch, options: { diagnosticDirectory?: string } = {}) {
  return new BrowserMcpProxy({
    mcpUrl: new URL(url),
    requestTimeoutMs: 1000
  }, undefined, { fetch: fetchImpl, probePollIntervalMs: 1, ...options });
}

function mcpServer(body: string, options: { malformed?: boolean; malformedContent?: boolean; stateful?: boolean; rejectInitialize?: boolean; modern?: boolean; unstructuredModern?: boolean; rejectLiteralNewlines?: boolean } = {}) {
  let closed = false;
  let sessionClosed = false;
  let initialized = false;
  const methods: string[] = [];
  const initializeProtocolVersions: string[] = [];
  const notificationHasIds: boolean[] = [];
  const sessionHeaders: Array<string | undefined> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.method === "GET") {
      res.writeHead(406, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported request" }));
      return;
    }
    if (req.method === "DELETE") {
      if (options.stateful && readHeader(req, "mcp-session-id") !== "session-42") {
        res.writeHead(404);
        res.end("session not found");
        return;
      }
      sessionClosed = true;
      res.writeHead(202);
      res.end();
      return;
    }
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      method: string;
      id?: unknown;
      params?: { name?: string; arguments?: { code?: unknown } };
    };
    const sessionHeader = readHeader(req, "mcp-session-id");
    methods.push(request.method);
    sessionHeaders.push(sessionHeader);
    if (request.method === "notifications/initialized") {
      notificationHasIds.push(Object.prototype.hasOwnProperty.call(request, "id"));
    }
    if (request.method === "initialize") {
      initializeProtocolVersions.push(String((request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion));
    }
    if (options.stateful && request.method !== "initialize" && sessionHeader !== "session-42") {
      res.writeHead(422, { "content-type": "text/plain" });
      res.end("Unexpected message, expect initialize request");
      return;
    }
    if (options.rejectInitialize && request.method === "initialize") {
      res.writeHead(422, { "content-type": "text/plain" });
      res.end("Unexpected message, expect initialize request");
      return;
    }
    if (options.malformed || (options.malformedContent && request.method === "tools/call" && (request.params?.name === "evaluate_script" || request.params?.name === "evaluate"))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not-json");
      return;
    }
    if (request.method === "initialize") {
      initialized = true;
    }
    if (request.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown = {};
    if (request.method === "tools/list") {
      result = options.modern
        ? { tools: [{ name: "tabs" }, { name: "read" }, { name: "evaluate" }] }
        : { tools: [
          { name: "new_hidden_page" },
          { name: "list_pages" },
          { name: "evaluate_script" },
          { name: "close_page" }
        ] };
    } else if (request.method === "tools/call" && options.modern && request.params?.name === "tabs") {
      const action = (request.params as { arguments?: { action?: string } }).arguments?.action;
      if (action === "new") {
        result = { structuredContent: { page: 42 } };
      } else if (action === "list") {
        result = { structuredContent: { pages: [] } };
      } else if (action === "close") {
        closed = true;
      }
    } else if (request.method === "tools/call" && request.params?.name === "new_hidden_page") {
      result = { structuredContent: { pageId: 42 } };
    } else if (request.method === "tools/call" && request.params?.name === "list_pages") {
      result = { structuredContent: { pages: [{ pageId: 42, isLoading: false, loadProgress: 1 }] } };
    } else if (request.method === "tools/call" && request.params?.name === "evaluate_script") {
      result = { structuredContent: { text: body } };
    } else if (request.method === "tools/call" && request.params?.name === "evaluate") {
      const code = request.params.arguments?.code;
      result = options.rejectLiteralNewlines && typeof code === "string" && code.includes("\\n")
        ? { content: [{ type: "text", text: "evaluate: SyntaxError: Invalid or unexpected token" }], isError: true }
        : req.url?.includes("structured=1") && !options.unstructuredModern
          ? { structuredContent: { value: body } }
          : { content: [{ type: "text", text: `[UNTRUSTED_PAGE_CONTENT origin=https://geo.example/json]\n${body}\n[END_UNTRUSTED_PAGE_CONTENT]` }] };
    } else if (request.method === "tools/call" && request.params?.name === "close_page") {
      closed = true;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.stateful && request.method === "initialize") {
      headers["mcp-session-id"] = "session-42";
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ jsonrpc: "2.0", result }));
  });
  return {
    server,
    wasClosed: () => closed,
    wasSessionClosed: () => sessionClosed,
    wasInitialized: () => initialized,
    methods,
    initializeProtocolVersions,
    notificationHasIds,
    sessionHeaders
  };
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

test("probes BrowserOS egress and cleans up the temporary page", async () => {
  const fixture = mcpServer(JSON.stringify({ country_code: "US", ip: "198.51.100.90" }), { stateful: true });
  const url = await listen(fixture.server);
  try {
    const result = await proxy(url).verifyEgress({
      verificationUrl: "https://geo.example/json",
      expectedCountryCode: "US",
      countryCodePath: "country_code",
      timeoutMs: 1000
    });
    assert.deepEqual(result, { ok: true, observedCountryCode: "US", observedIp: "198.51.100.90" });
    assert.equal(fixture.wasClosed(), true);
    assert.equal(fixture.wasInitialized(), true);
    assert.equal(fixture.wasSessionClosed(), true);
    assert.deepEqual(fixture.initializeProtocolVersions, ["2025-06-18"]);
    assert.deepEqual(fixture.methods.slice(0, 2), ["initialize", "notifications/initialized"]);
    assert.deepEqual(fixture.notificationHasIds, [false]);
    assert.ok(fixture.sessionHeaders.slice(1).every((value) => value === "session-42"));
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("supports the modern BrowserOS tabs, read, and evaluate tools", async () => {
  const fixture = mcpServer(JSON.stringify({ country_code: "US", ip: "198.51.100.90" }), {
    stateful: true,
    modern: true,
    rejectLiteralNewlines: true
  });
  const url = await listen(fixture.server);
  try {
    const result = await proxy(url).verifyEgress({
      verificationUrl: "https://geo.example/json",
      expectedCountryCode: "US",
      countryCodePath: "country_code",
      timeoutMs: 1000
    });
    assert.deepEqual(result, { ok: true, observedCountryCode: "US", observedIp: "198.51.100.90" });
    assert.equal(fixture.wasClosed(), true);
    assert.equal(fixture.wasSessionClosed(), true);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("parses the BrowserOS untrusted page wrapper when structured content is unavailable", async () => {
  const fixture = mcpServer(JSON.stringify({ country_code: "US", ip: "198.51.100.90" }), {
    stateful: true,
    modern: true,
    unstructuredModern: true
  });
  const url = await listen(fixture.server);
  const diagnosticDirectory = mkdtempSync(join(tmpdir(), "gttd-browseros-"));
  try {
    const result = await proxy(url, undefined, { diagnosticDirectory }).verifyEgress({
      verificationUrl: "https://geo.example/json",
      expectedCountryCode: "US",
      countryCodePath: "country_code",
      timeoutMs: 1000
    });
    assert.deepEqual(result, { ok: true, observedCountryCode: "US", observedIp: "198.51.100.90" });
    const diagnostic = readFileSync(join(diagnosticDirectory, "browseros-mcp-responses.txt"), "utf8");
    assert.match(diagnostic, /UNTRUSTED_PAGE_CONTENT/);
    assert.doesNotMatch(diagnostic, /geo\.example/);
  } finally {
    rmSync(diagnosticDirectory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("checks BrowserOS readiness through an MCP initialize session instead of GET", async () => {
  const fixture = mcpServer(JSON.stringify({ country_code: "US", ip: "198.51.100.90" }), { stateful: true });
  const url = await listen(fixture.server);
  try {
    const result = await proxy(url).checkReady();
    assert.deepEqual(result, { ok: true, statusCode: 200 });
    assert.deepEqual(fixture.methods, ["initialize", "notifications/initialized"]);
    assert.equal(fixture.wasSessionClosed(), true);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("fails during initialization without attempting tools/list and redacts credentialed URLs", async () => {
  const fixture = mcpServer("", { stateful: true, rejectInitialize: true });
  const url = await listen(fixture.server);
  try {
    await assert.rejects(
      () => proxy(url).verifyEgress({
        verificationUrl: "https://user:secret@geo.example/json",
        expectedCountryCode: "US",
        countryCodePath: "country_code",
        timeoutMs: 1000
      }),
      (error) => {
        assert.equal((error as AppError).code, "browseros_probe_http_error");
        assert.equal((error as AppError).details?.statusCode, 422);
        assert.equal((error as AppError).details?.mcpMethod, "initialize");
        assert.doesNotMatch(String(error), /user|secret|geo\.example/i);
        return true;
      }
    );
    assert.deepEqual(fixture.methods, ["initialize"]);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("cleans up the page and MCP session after content verification fails", async () => {
  const fixture = mcpServer("not-json", { stateful: true, malformedContent: true });
  const url = await listen(fixture.server);
  try {
    await assert.rejects(
      () => proxy(url).verifyEgress({
        verificationUrl: "https://geo.example/json",
        expectedCountryCode: "US",
        countryCodePath: "country_code",
        timeoutMs: 1000
      }),
      (error) => {
        assert.equal((error as AppError).code, "browseros_probe_malformed_response");
        return true;
      }
    );
    assert.equal(fixture.wasClosed(), true);
    assert.equal(fixture.wasSessionClosed(), true);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("returns a sanitized malformed-response error and still closes the page", async () => {
  const fixture = mcpServer("not-json");
  const url = await listen(fixture.server);
  try {
    await assert.rejects(
      () => proxy(url).verifyEgress({
        verificationUrl: "https://geo.example/json",
        expectedCountryCode: "US",
        countryCodePath: "country_code",
        timeoutMs: 1000
      }),
      (error) => {
        assert.equal((error as AppError).code, "browseros_probe_malformed_response");
        assert.doesNotMatch(String(error), /geo\.example|secret/i);
        return true;
      }
    );
    assert.equal(fixture.wasClosed(), true);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("reports a country mismatch from BrowserOS verification", async () => {
  const fixture = mcpServer(JSON.stringify({ country_code: "GB", ip: "198.51.100.91" }));
  const url = await listen(fixture.server);
  try {
    await assert.rejects(
      () => proxy(url).verifyEgress({
        verificationUrl: "https://geo.example/json",
        expectedCountryCode: "US",
        countryCodePath: "country_code",
        timeoutMs: 1000
      }),
      (error) => {
        assert.equal((error as AppError).code, "browseros_egress_country_mismatch");
        return true;
      }
    );
    assert.equal(fixture.wasClosed(), true);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("maps an MCP timeout to a BrowserOS probe timeout", async () => {
  const fetchImpl = async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  await assert.rejects(
    () => proxy("http://127.0.0.1:1/mcp", fetchImpl).verifyEgress({
      verificationUrl: "https://geo.example/json",
      expectedCountryCode: "US",
      countryCodePath: "country_code",
      timeoutMs: 1000
    }),
    (error) => {
      assert.equal((error as AppError).code, "browseros_probe_timeout");
      return true;
    }
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { JsonLogger } from "../src/logger.js";

test("prints readable sanitized info logs to stdout and errors to stderr", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logger = new JsonLogger({
    directory: "",
    retentionFiles: 0,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line)
  });

  logger.info("request_completed", {
    apiToken: "top-secret-token",
    proxyUrl: "http://proxy-user:proxy-password@example.test:8080"
  });
  logger.error("request_failed", { authorization: "Bearer top-secret-token" });

  assert.equal(stdout.length, 1);
  assert.match(stdout[0], /^\d{4}-\d{2}-\d{2}T.* INFO request_completed /);
  assert.match(stdout[0], /\*\*\*\*/);
  assert.doesNotMatch(stdout[0], /top-secret-token|proxy-password/);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], / ERROR request_failed /);
  assert.doesNotMatch(stderr[0], /top-secret-token/);
});

test("can disable terminal output for tests and embedded callers", () => {
  const stdout: string[] = [];
  const logger = new JsonLogger({
    directory: "",
    retentionFiles: 0,
    terminal: false,
    stdout: (line: string) => stdout.push(line)
  });

  logger.info("not_printed");

  assert.deepEqual(stdout, []);
});

test("redacts credentials from embedded URLs and bearer values in error text", () => {
  const stderr: string[] = [];
  const logger = new JsonLogger({
    directory: "",
    retentionFiles: 0,
    stdout: () => undefined,
    stderr: (line: string) => stderr.push(line)
  });

  logger.error("upstream_failed", {
    error: "connect http://proxy-user:proxy-password@example.test:8080 failed; Authorization: Bearer api-secret"
  });

  assert.equal(stderr.length, 1);
  assert.doesNotMatch(stderr[0], /proxy-user|proxy-password|api-secret/);
  assert.match(stderr[0], /\*\*\*\*/);
});

test("redacts sensitive query parameters from URLs", () => {
  const stdout: string[] = [];
  const logger = new JsonLogger({
    directory: "",
    retentionFiles: 0,
    stdout: (line: string) => stdout.push(line)
  });

  logger.info("request_url", {
    url: "https://example.test/check?token=query-secret&password=proxy-secret&country=US"
  });

  assert.equal(stdout.length, 1);
  assert.doesNotMatch(stdout[0], /query-secret|proxy-secret/);
  assert.match(stdout[0], /country=US/);
});

test("redacts API keys in structured metadata and free-text errors", () => {
  const stderr: string[] = [];
  const logger = new JsonLogger({
    directory: "",
    retentionFiles: 0,
    stdout: () => undefined,
    stderr: (line: string) => stderr.push(line)
  });

  logger.error("webshare_failed", {
    apiKey: "camel-case-secret",
    WEBSHARE_API_KEY: "environment-secret",
    error: "WEBSHARE_API_KEY=embedded-secret"
  });

  assert.equal(stderr.length, 1);
  assert.doesNotMatch(stderr[0], /camel-case-secret|environment-secret|embedded-secret/);
  assert.match(stderr[0], /\*\*\*\*/);
});

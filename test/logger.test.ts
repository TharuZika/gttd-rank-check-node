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

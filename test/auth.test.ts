import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorized } from "../src/auth.js";

test("accepts the exact bearer token and rejects malformed auth headers", () => {
  const token = "a".repeat(32);

  assert.equal(isAuthorized({ authorization: `Bearer ${token}` }, token), true);
  assert.equal(isAuthorized({ authorization: token }, token), false);
  assert.equal(isAuthorized({ authorization: `Basic ${token}` }, token), false);
  assert.equal(isAuthorized({}, token), false);
});

test("rejects wrong tokens without leaking length behavior through direct comparison", () => {
  const token = "b".repeat(32);

  assert.equal(isAuthorized({ authorization: `Bearer ${"b".repeat(31)}` }, token), false);
  assert.equal(isAuthorized({ authorization: `Bearer ${"c".repeat(32)}` }, token), false);
});

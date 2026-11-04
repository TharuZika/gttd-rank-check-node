import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const scriptPath = join(process.cwd(), "scripts", "diagnose.ps1");

test("diagnostic script does not print raw network exception details", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.doesNotMatch(script, /\$\(\$?_\.Exception\.Message\)/i);
  assert.match(script, /network failure: unable to reach gateway/i);
});

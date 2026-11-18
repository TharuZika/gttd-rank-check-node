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

test("diagnostic script distinguishes Cloudflare edge mitigation from proxied origin responses", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /cloudflare-edge/i);
  assert.match(script, /cloudflare-proxied/i);
  assert.match(script, /cf-mitigated/i);
  assert.match(script, /content-type/i);
});

test("diagnostic script reports safe gateway and BrowserOS error codes without printing response bodies", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /gateway-error/i);
  assert.match(script, /browser-error/i);
  assert.doesNotMatch(script, /Write-(?:Host|Warning).*\$response\.Content/i);
});

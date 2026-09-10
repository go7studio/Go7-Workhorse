import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILL = path.join(ROOT, "skills", "dgx-spark", "SKILL.md");
const SCRIPT = path.join(ROOT, "skills", "dgx-spark", "scripts", "collect-delivery.ps1");

test("dgx-spark ships as a Workhorse skill that collects /v1/models and never embeds secrets", () => {
  const text = readFileSync(SKILL, "utf8");
  assert.match(text, /^---\r?\nname:\s*dgx-spark\s*$/m);
  assert.match(text, /\/dgx-spark/);
  assert.match(text, /\/v1\/models/);
  assert.match(text, /workhorse_setup_custom_bot/);
  assert.match(text, /NVIDIA Sync is SSH/);
  assert.match(text, /qwen3\.8-27b/);
  assert.doesNotMatch(text, /BEGIN OPENSSH|sk-ant-|ghp_|tskey-/);
  assert.doesNotMatch(text, /password\s*[:=]\s*\S+/i);
  assert.equal(existsSync(SCRIPT), true);
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /\/v1\/models/);
  assert.match(script, /never the bearer/i);
  assert.doesNotMatch(script, /Write-Host \$token/);
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CURRENT_STATE_VERSION,
  readComposerDraftFile,
  readVersionedState,
  writeComposerDraftFile,
  writeVersionedState,
} from "../electron/state-persistence";

const scrub = (state: Record<string, unknown>) => JSON.parse(
  JSON.stringify(state, (key, value) => key === "apiKey" ? undefined : value),
) as Record<string, unknown>;

test("versioned state writes atomically and scrubs every rotated legacy backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-state-"));
  const file = path.join(dir, "state.json");
  const legacy = JSON.stringify({ settings: { custom: { apiKey: "legacy-secret" } }, sessions: [{ id: "old" }] });
  fs.writeFileSync(file, legacy, "utf8");
  fs.writeFileSync(`${file}.bak`, legacy, "utf8");
  fs.writeFileSync(`${file}.bak.1`, legacy, "utf8");
  writeVersionedState(file, { sessions: [{ id: "new" }], settings: { custom: { apiKey: "new-secret" } } }, scrub);
  for (const target of [file, `${file}.bak`, `${file}.bak.1`, `${file}.bak.2`]) {
    const text = fs.readFileSync(target, "utf8");
    assert.doesNotMatch(text, /legacy-secret|new-secret/);
    assert.equal(JSON.parse(text).stateVersion, CURRENT_STATE_VERSION);
  }
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-") || name.includes(".replace-")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("state reader falls back through backups after corruption", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-recover-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{broken", "utf8");
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ sessions: [{ id: "recovered" }] }), "utf8");
  const result = readVersionedState(file);
  assert.equal(result.recovered, true);
  assert.equal((result.state.sessions as Array<{ id: string }>)[0]?.id, "recovered");
  assert.equal(result.state.stateVersion, CURRENT_STATE_VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("newer unknown state versions are skipped in favor of a compatible backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-version-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ stateVersion: 999, sessions: [{ id: "future" }] }), "utf8");
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ stateVersion: 2, sessions: [{ id: "known" }] }), "utf8");
  assert.equal(((readVersionedState(file).state.sessions as Array<{ id: string }>)[0]?.id), "known");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("composer drafts write a sidecar and vanish when empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-drafts-"));
  const file = path.join(dir, "state.json");
  writeComposerDraftFile(file, { sess_1: { text: "still typing" } });
  assert.equal((readComposerDraftFile(file).sess_1 as { text?: string })?.text, "still typing");
  writeComposerDraftFile(file, {});
  assert.deepEqual(readComposerDraftFile(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

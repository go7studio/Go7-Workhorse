import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isSettingsSection, normalizeSettings } from "../src/lib/settings";
import { DEFAULT_WORKSHOP_SETTINGS, type PackListing } from "../src/lib/workshop-pack";
import { nextPacks, packSettings } from "../src/ui/WorkshopBlock";

const ROOT = path.resolve(import.meta.dirname, "..");
const block = readFileSync(path.join(ROOT, "src", "ui", "WorkshopBlock.tsx"), "utf8");

function listing(over: Partial<PackListing> & { id: string }): PackListing {
  return {
    name: over.id,
    version: "1.0.0",
    contract: 1,
    description: "",
    on: false,
    sources: [
      { id: "feed", kind: "json", path: "feed", pollMs: 2000, maxBytes: 262144 },
      { id: "infer", kind: "probes", probes: ["healthz"], pollMs: 5000 },
    ],
    granted: [],
    ...over,
  };
}

const box = listing({ id: "box-monitor", on: true, hostId: "spark", granted: ["feed"], version: "1.2.0" });
const log = listing({ id: "job-log", version: "0.3.1" });

test("workshop settings are a block under Skills, not a Settings section; legacy grants rows come back off", () => {
  assert.equal(isSettingsSection("workshop"), false);
  assert.equal(isSettingsSection("skills"), true);
  const settings = normalizeSettings({
    workshop: {
      packs: [
        { id: "box-monitor", on: true, grants: ["read.box.metrics"] },
        { id: "job-log", on: true, hostId: "spark", sources: ["log", "log"], version: "1.2.3", contract: 1 },
        { id: "Nope", on: true, hostId: "spark", sources: ["feed"] },
      ],
    },
  });
  assert.deepEqual(settings.workshop, {
    packs: [
      { id: "box-monitor", on: false, sources: [] },
      { id: "job-log", on: true, sources: ["log"], hostId: "spark", version: "1.2.3", contract: 1 },
    ],
  });
  assert.deepEqual(normalizeSettings({}).workshop, DEFAULT_WORKSHOP_SETTINGS);
});

test("the block shows the exact URLs main will fetch and never a token", () => {
  assert.match(block, /packSourceUrls\(host\.baseUrl, pack\.id/);
  assert.match(block, /className="workshop-url"/);
  assert.doesNotMatch(block, /token/i);
  assert.doesNotMatch(block, /bearer/i);
});

test("the block never says git and paints no start or stop control", () => {
  assert.doesNotMatch(block, /\bgit\b/i);
  assert.doesNotMatch(block, />\s*(Start|Stop|Run|Route|Lease)\s*</);
  assert.doesNotMatch(block, /\b(lease|route|start|stop|kill)(Job|Pack|Run)?\(/);
  assert.doesNotMatch(block, /workshop(Start|Stop|Kill|Route|Lease)/);
  // Nothing from a pack executes: the collector is only revealed.
  assert.match(block, /workshopRevealCollector/);
  assert.match(block, /Workhorse never runs it/);
  assert.doesNotMatch(block, /child_process|execFile|spawn\(/);
});

test("the block installs, removes, and updates through the workshop bridge", () => {
  for (const name of ["workshopList", "workshopInstallRepo", "workshopInstallFolder", "workshopRemove", "workshopCheckUpdate", "workshopUpdate", "onWorkshopChanged"]) {
    assert.match(block, new RegExp(name), name);
  }
  assert.match(block, /placeholder="https:\/\/github\.com\/owner\/repo"/);
  assert.match(block, /Sources changed\. Turn on to review\./);
  assert.match(block, /Add a Local Compute host under Settings → LLMs first\./);
  // Confirm needs a host and at least one checked source.
  assert.match(block, /disabled=\{busy \|\| !hostId \|\| checked\.length === 0\}/);
});

test("the block persists through updateWorkshop with sources, and Detach never opens on confirm", () => {
  assert.match(block, /await store\.updateWorkshop\(\{ packs: next \}\)/);
  assert.match(block, /sources: checked/);
  assert.match(block, />\s*Detach\s*</);
  const turnOn = block.slice(block.indexOf("const turnOn"), block.indexOf("const turnOff"));
  assert.doesNotMatch(turnOn, /workshopOpenBreakout/);
  assert.match(block, /workshopCloseBreakout/);
});

test("packSettings mirrors the live list: on rows keep granted sources, off rows keep none", () => {
  assert.deepEqual(packSettings([box, log]), [
    { id: "box-monitor", on: true, sources: ["feed"], hostId: "spark", version: "1.2.0", contract: 1 },
    { id: "job-log", on: false, sources: [], version: "0.3.1", contract: 1 },
  ]);
});

test("nextPacks turns one pack on without dropping or staling the other", () => {
  const rows = nextPacks([box, log], { id: "job-log", on: true, hostId: "spark", sources: ["feed", "infer", "infer"] });
  assert.deepEqual(rows, [
    { id: "box-monitor", on: true, sources: ["feed"], hostId: "spark", version: "1.2.0", contract: 1 },
    { id: "job-log", on: true, hostId: "spark", sources: ["feed", "infer"], version: "0.3.1", contract: 1 },
  ]);
});

test("nextPacks turns one pack off and leaves the other on", () => {
  const rows = nextPacks([box, log], { id: "box-monitor", on: false });
  assert.deepEqual(rows, [
    { id: "box-monitor", on: false, sources: [], hostId: "spark", version: "1.2.0", contract: 1 },
    { id: "job-log", on: false, sources: [], version: "0.3.1", contract: 1 },
  ]);
  assert.equal(rows.some((row) => row.on), false);
});

test("nextPacks refuses a confirm with no checked source or no host: the list comes back unchanged", () => {
  const before = packSettings([box, log]);
  assert.deepEqual(nextPacks([box, log], { id: "job-log", on: true, hostId: "spark", sources: [] }), before);
  assert.deepEqual(nextPacks([box, log], { id: "job-log", on: true, hostId: "", sources: ["feed"] }), before);
  assert.deepEqual(nextPacks([box, log], { id: "job-log", on: true, sources: ["feed"] }), before);
});

test("a reconfirm after update turns only that pack off", () => {
  const both = [box, listing({ id: "job-log", on: true, hostId: "spark", granted: ["feed", "infer"] })];
  const rows = nextPacks(both, { id: "job-log", on: false });
  assert.deepEqual(rows.map((row) => [row.id, row.on, row.sources]), [
    ["box-monitor", true, ["feed"]],
    ["job-log", false, []],
  ]);
});

test("nextPacks appends a pack the live list does not know yet", () => {
  const rows = nextPacks([box], { id: "job-log", on: true, hostId: "spark", sources: ["feed"] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { id: "job-log", on: true, hostId: "spark", sources: ["feed"], version: undefined, contract: undefined });
});

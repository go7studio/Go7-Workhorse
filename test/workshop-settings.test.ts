import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isSettingsSection, normalizeSettings } from "../src/lib/settings";
import { DEFAULT_WORKSHOP_SETTINGS, fingerprintsForSources, type PackListing, type PackSource } from "../src/lib/workshop-pack";
import {
  availableSearchMatch,
  nextPacks,
  nextPacksOff,
  packSettings,
  turnOnPreflight,
  turnOnRefuseReason,
  WORKSHOP_MISSING_HOST,
} from "../src/ui/WorkshopBlock";

const ROOT = path.resolve(import.meta.dirname, "..");
const block = readFileSync(path.join(ROOT, "src", "ui", "WorkshopBlock.tsx"), "utf8");

const LISTING_SOURCES: PackListing["sources"] = [
  { id: "feed", kind: "json", path: "feed", pollMs: 2000, maxBytes: 262144 },
  { id: "infer", kind: "probes", probes: ["healthz"], pollMs: 5000 },
];

function listing(over: Partial<PackListing> & { id: string }): PackListing {
  return {
    name: over.id,
    version: "1.0.0",
    contract: 1,
    description: "",
    on: false,
    sources: LISTING_SOURCES,
    granted: [],
    ...over,
  };
}

function confirmFingerprints(packId: string, granted: string[]): Record<string, string> {
  const sources: PackSource[] = LISTING_SOURCES.map((source) =>
    source.kind === "json"
      ? { id: source.id, kind: "json", path: source.path ?? "", pollMs: source.pollMs, freshMs: source.pollMs, maxBytes: source.maxBytes ?? 0 }
      : { id: source.id, kind: "probes", probes: source.probes ?? [], pollMs: source.pollMs },
  );
  return fingerprintsForSources(packId, sources, granted);
}

const boxFingerprints = confirmFingerprints("box-monitor", ["feed"]);
const box = listing({
  id: "box-monitor", on: true, hostId: "spark", granted: ["feed"], version: "1.2.0",
  sourceFingerprints: boxFingerprints,
});
const log = listing({ id: "job-log", version: "0.3.1" });

test("workshop settings are a Settings section; legacy grants rows come back off", () => {
  assert.equal(isSettingsSection("workshop"), true);
  assert.equal(isSettingsSection("skills"), true);
  const fingerprints = { log: '{"kind":"json"}' };
  const settings = normalizeSettings({
    workshop: {
      packs: [
        { id: "box-monitor", on: true, grants: ["read.box.metrics"] },
        { id: "job-log", on: true, hostId: "spark", sources: ["log", "log"], sourceFingerprints: fingerprints, version: "1.2.3", contract: 1 },
        { id: "Nope", on: true, hostId: "spark", sources: ["feed"] },
      ],
    },
  });
  assert.deepEqual(settings.workshop, {
    packs: [
      { id: "box-monitor", on: false, sources: [] },
      { id: "job-log", on: true, sources: ["log"], hostId: "spark", sourceFingerprints: fingerprints, version: "1.2.3", contract: 1 },
    ],
  });
  assert.deepEqual(normalizeSettings({}).workshop, DEFAULT_WORKSHOP_SETTINGS);
});

test("the block shows the exact URLs main will fetch and never a token", () => {
  assert.match(block, /packSourceUrls\(host\.baseUrl, pack\.id/);
  assert.match(block, /className="workshop-url"/);
  assert.match(block, /shortSourceUrl/);
  assert.match(block, /title=\{line\}/);
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
  assert.match(block, /Collector · Reveal/);
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
  assert.match(block, /sources: grantSources/);
  assert.match(block, />\s*Detach\s*</);
  const turnOn = block.slice(block.indexOf("const turnOn"), block.indexOf("const turnOff"));
  assert.doesNotMatch(turnOn, /workshopOpenBreakout/);
  assert.match(block, /workshopCloseBreakout/);
});

test("packSettings mirrors the live list: on rows keep granted sources, off rows keep none", () => {
  assert.deepEqual(packSettings([box, log]), [
    { id: "box-monitor", on: true, sources: ["feed"], sourceFingerprints: boxFingerprints, hostId: "spark", version: "1.2.0", contract: 1 },
    { id: "job-log", on: false, sources: [], version: "0.3.1", contract: 1 },
  ]);
});

test("nextPacks turns one pack on without dropping or staling the other", () => {
  const fps = confirmFingerprints("job-log", ["feed", "infer"]);
  const rows = nextPacks([box, log], { id: "job-log", on: true, hostId: "spark", sources: ["feed", "infer", "infer"], sourceFingerprints: fps });
  assert.deepEqual(rows, [
    { id: "box-monitor", on: true, sources: ["feed"], sourceFingerprints: boxFingerprints, hostId: "spark", version: "1.2.0", contract: 1 },
    { id: "job-log", on: true, hostId: "spark", sources: ["feed", "infer"], sourceFingerprints: fps, version: "0.3.1", contract: 1 },
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

test("nextPacks refuses a confirm with no checked source, no host, or no fingerprints", () => {
  const before = packSettings([box, log]);
  assert.deepEqual(nextPacks([box, log], { id: "job-log", on: true, hostId: "spark", sources: [] }), before);
  assert.deepEqual(nextPacks([box, log], { id: "job-log", on: true, hostId: "", sources: ["feed"] }), before);
  assert.deepEqual(nextPacks([box, log], { id: "job-log", on: true, sources: ["feed"] }), before);
  assert.deepEqual(nextPacks([box, log], { id: "job-log", on: true, hostId: "spark", sources: ["feed"] }), before);
});

test("Turn on names the refuse instead of staying silently Off", () => {
  assert.equal(turnOnRefuseReason({ id: "box-monitor", on: true, sources: ["feed"] }), WORKSHOP_MISSING_HOST);
  assert.match(turnOnRefuseReason({ id: "box-monitor", on: true, hostId: "spark", sources: [] }) ?? "", /source/);
  assert.equal(
    turnOnRefuseReason({
      id: "box-monitor",
      on: true,
      hostId: "spark",
      sources: ["feed"],
      sourceFingerprints: boxFingerprints,
    }),
    null,
  );
  assert.match(block, /beginTurnOn/);
  assert.match(block, /turnOnWith/);
  assert.match(block, /Could not turn on/);
  assert.match(block, /grantRefuseId/);
  assert.match(block, /workshop-grant-refuse/);
  assert.match(block, /setSettingsSection\("llms"\)/);
  assert.match(block, />\s*Open LLMs\s*</);
  assert.doesNotMatch(block.slice(block.indexOf("const beginTurnOn"), block.indexOf("const turnOff")), /openConfirm\(pack\);\s*setNote\(missingHostCopy/);
});

test("catalog search matches name and summary; empty query keeps every pack", () => {
  assert.equal(availableSearchMatch("", "Box monitor health watts"), true);
  assert.equal(availableSearchMatch("  ", "Box monitor"), true);
  assert.equal(availableSearchMatch("box", "Box monitor health and load"), true);
  assert.equal(availableSearchMatch("watts", "Box monitor health and load"), false);
  assert.equal(availableSearchMatch("JOB", "Job log read-only tail"), true);
  assert.match(block, /aria-label="Search catalog"/);
  assert.match(block, /workshop-catalog-search/);
  assert.match(block, /No packs match/);
  assert.match(block, /pack-card-grid/);
  assert.match(block, /workshop-pack-status">Off</);
  assert.match(block, /Installed · Off — Turn on when ready\./);
});

test("a reconfirm after update turns every affected pack off", () => {
  const both = [box, listing({ id: "job-log", on: true, hostId: "spark", granted: ["feed", "infer"] })];
  const rows = nextPacksOff(both, ["box-monitor", "job-log"]);
  assert.deepEqual(rows.map((row) => [row.id, row.on, row.sources]), [
    ["box-monitor", false, []],
    ["job-log", false, []],
  ]);
});

test("nextPacks appends a pack the live list does not know yet", () => {
  const fps = confirmFingerprints("job-log", ["feed"]);
  const rows = nextPacks([box], { id: "job-log", on: true, hostId: "spark", sources: ["feed"], sourceFingerprints: fps });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { id: "job-log", on: true, hostId: "spark", sources: ["feed"], sourceFingerprints: fps, version: undefined, contract: undefined });
});

test("the preflight names every missing piece, not only the first", () => {
  assert.deepEqual(turnOnPreflight(1, 1, 2), { ok: true, missing: [], copy: "" });

  const noHost = turnOnPreflight(0, 0, 2);
  assert.equal(noHost.ok, false);
  assert.deepEqual(noHost.missing, ["host"]);
  assert.match(noHost.copy, /Local Compute host/);

  // A configured but switched-off host is a different fix from having none.
  const offHost = turnOnPreflight(1, 0, 2);
  assert.deepEqual(offHost.missing, ["enabled-host"]);
  assert.match(offHost.copy, /switched on/);

  // Both gaps are named in one strip, so the second is not a surprise after fixing the first.
  const both = turnOnPreflight(0, 0, 0);
  assert.deepEqual(both.missing, ["host", "sources"]);
  assert.match(both.copy, /Local Compute host · at least one source/);

  assert.deepEqual(turnOnPreflight(2, 2, 0).missing, ["sources"]);
});

test("a refused Turn on offers the fix in place and still points at LLMs", () => {
  // The strip reads the preflight, so it also appears for a missing source, not only a missing host.
  assert.match(block, /grantRefuseId === pack\.id && !preflight\.ok/);
  assert.match(block, /className="workshop-preflight-copy"/);
  assert.match(block, />\s*Add host\s*</);
  assert.match(block, /LocalComputeAddHost/);
  assert.match(block, /addHostFor/);
  // The credential field lives in the shared form; this block still never names one.
  assert.doesNotMatch(block, /token/i);
});

test("Workshop is a chat basic beside Review and Terminal", () => {
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(pane, /const \[workshopOpen, setWorkshopOpen\] = useState\(false\)/);
  assert.match(pane, />\s*Workshop\s*</);
  assert.match(pane, /<WorkshopPanel onClose=\{\(\) => setWorkshopOpen\(false\)\}/);
  // Closing a chat closes the drawer with it, the way the terminal already does.
  assert.match(pane, /setTerminalOpen\(false\);\s+setWorkshopOpen\(false\);/);

  const panel = readFileSync(path.join(ROOT, "src", "ui", "WorkshopPanel.tsx"), "utf8");
  assert.match(panel, /useWorkshopLive/);
  assert.match(panel, /surface="sheet"/);
  // Read-only, the same law every other Workshop surface keeps.
  assert.doesNotMatch(panel, /Turn off|updateWorkshop|job\.start|job\.stop|ssh/);
  assert.doesNotMatch(panel, /\blease\w*\(|\broute\w*\(|\bstart\w*\(|\bstop\w*\(/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|<iframe|<webview|eval\(|new Function/);
});

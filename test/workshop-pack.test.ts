import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  PACK_LIMITS,
  WORKSHOP_UNKNOWN,
  bindingHas,
  disablePacksForReconfirm,
  documentWithinLimits,
  fingerprintsForSources,
  grantsMatchFingerprints,
  highestSemverTag,
  normalizeWorkshopSettings,
  packSourceUrls,
  paintValue,
  parseBinding,
  parsePointer,
  parseWorkshopPack,
  pickCase,
  pointerGet,
  ratioPercent,
  resolveBinding,
  sourceFingerprint,
  type PackDocuments,
  type Widget,
} from "../src/lib/workshop-pack";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "test", "fixtures", "workshop");

function fixture(id: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, id, "pack.json"), "utf8"));
}

/** A valid minimal pack to mutate in refusal tests. */
function minimal(): Record<string, unknown> {
  return {
    id: "sample", name: "Sample", version: "1.0.0", contract: 1, description: "A sample.",
    sources: [{ id: "feed", kind: "json", path: "feed" }],
    strip: [{ w: "text", of: "feed:/a" }],
    cards: [{ title: "Card", rows: [{ w: "kv", label: "A", of: "feed:/a" }] }],
  };
}

test("fixture packs parse and every widget kind is exercised by at least one", () => {
  const kinds = new Set<string>();
  const walk = (w: Widget) => {
    kinds.add(w.w);
    if (w.w === "hbox") w.children.forEach(walk);
    if (w.w === "switch") {
      w.cases.forEach((c) => walk(c.paint));
      if (w.else) walk(w.else);
    }
  };
  for (const id of fs.readdirSync(FIXTURES)) {
    const parsed = parseWorkshopPack(fixture(id), id);
    assert.equal(parsed.ok, true, `${id}: ${parsed.ok ? "" : parsed.reason}`);
    if (parsed.ok) {
      parsed.pack.strip.forEach(walk);
      parsed.pack.cards.forEach((c) => {
        c.rows.forEach(walk);
        if (c.aside) walk(c.aside);
      });
    }
  }
  for (const kind of ["ring", "bar", "text", "kv", "pair", "meta", "note", "chips", "probes", "flags", "log", "hbox", "switch"]) {
    assert.ok(kinds.has(kind), `fixtures exercise ${kind}`);
  }
});

test("parseWorkshopPack refuses anything outside the vocabulary, naming the field", () => {
  assert.equal(parseWorkshopPack(minimal(), "sample").ok, true);
  const cases: Array<[string, (p: Record<string, unknown>) => void, RegExp]> = [
    ["folder mismatch", (p) => { p.id = "other"; }, /does not match folder/],
    ["bad id", (p) => { p.id = "Bad_Id"; }, /^id/],
    ["contract ahead", (p) => { p.contract = 2; }, /needs a newer Workhorse/],
    ["contract missing", (p) => { delete p.contract; }, /contract/],
    ["bad version", (p) => { p.version = "1.0"; }, /version/],
    ["unknown field", (p) => { p.entry = "panel/index.html"; }, /unknown field "entry"/],
    ["http homepage", (p) => { p.homepage = "http://x.test"; }, /homepage/],
    ["no sources", (p) => { p.sources = []; }, /sources/],
    ["too many sources", (p) => { p.sources = Array.from({ length: PACK_LIMITS.maxSources + 1 }, (_, i) => ({ id: `s${i}`, kind: "json", path: "x" })); }, /at most/],
    ["absolute path", (p) => { p.sources = [{ id: "feed", kind: "json", path: "/feed" }]; }, /bad path/],
    ["dotdot path", (p) => { p.sources = [{ id: "feed", kind: "json", path: "../v1/keys" }]; }, /bad path/],
    ["query path", (p) => { p.sources = [{ id: "feed", kind: "json", path: "feed?x=1" }]; }, /bad path/],
    ["url path", (p) => { p.sources = [{ id: "feed", kind: "json", path: "https://evil.test/x" }]; }, /bad path/],
    ["encoded path", (p) => { p.sources = [{ id: "feed", kind: "json", path: "fe%2eed" }]; }, /bad path/],
    ["reserved source id", (p) => { p.sources = [{ id: "desk", kind: "json", path: "feed" }]; (p.strip as unknown[]) = []; p.cards = [{ title: "C", rows: [{ w: "note", value: "x" }] }]; }, /bad id/],
    ["poll too fast", (p) => { p.sources = [{ id: "feed", kind: "json", path: "feed", pollMs: 500 }]; }, /pollMs/],
    ["bytes too big", (p) => { p.sources = [{ id: "feed", kind: "json", path: "feed", maxBytes: PACK_LIMITS.maxBytes + 1 }]; }, /maxBytes/],
    ["unknown probe", (p) => { p.sources = [{ id: "feed", kind: "json", path: "feed" }, { id: "i", kind: "probes", probes: ["keys"] }]; }, /unknown or duplicate probe/],
    ["unknown source kind", (p) => { p.sources = [{ id: "feed", kind: "sse", path: "feed" }]; }, /unknown kind/],
    ["unknown widget", (p) => { p.strip = [{ w: "button", label: "Start" }]; }, /unknown widget "button"/],
    ["unknown fmt", (p) => { p.strip = [{ w: "text", of: "feed:/a", fmt: "money" }]; }, /unknown fmt/],
    ["unknown source in binding", (p) => { p.strip = [{ w: "text", of: "other:/a" }]; }, /unknown source "other"/],
    ["proto pointer", (p) => { p.strip = [{ w: "text", of: "feed:/__proto__/x" }]; }, /bad binding/],
    ["bad pointer escape", (p) => { p.strip = [{ w: "text", of: "feed:/a~2" }]; }, /bad binding/],
    ["probes widget on json source", (p) => { p.strip = [{ w: "probes", of: "feed" }]; }, /probes needs a probes source/],
    ["log too long", (p) => { p.strip = [{ w: "log", of: "feed:/t", lines: PACK_LIMITS.maxLogLines + 1 }]; }, /log lines/],
    ["switch both is and has", (p) => { p.strip = [{ w: "switch", cases: [{ when: "feed:/a", is: 1, has: true, paint: { w: "note", value: "x" } }] }]; }, /exactly one of is\/has/],
    ["ring size", (p) => { p.strip = [{ w: "ring", of: "feed:/a", size: 200 }]; }, /ring size/],
    ["no cards", (p) => { p.cards = []; }, /cards/],
    ["card without rows", (p) => { p.cards = [{ title: "C", rows: [] }]; }, /rows/],
  ];
  for (const [label, mutate, expect] of cases) {
    const p = minimal();
    mutate(p);
    const parsed = parseWorkshopPack(p, "sample");
    assert.equal(parsed.ok, false, `${label} must be refused`);
    if (!parsed.ok) assert.match(parsed.reason, expect, `${label}: ${parsed.reason}`);
  }
});

test("JSON pointers: RFC 6901 escapes, own properties only, no prototype walk", () => {
  assert.deepEqual(parsePointer(""), []);
  assert.deepEqual(parsePointer("/a~1b/c~0d"), ["a/b", "c~d"]);
  assert.equal(parsePointer("a/b"), null);
  assert.equal(parsePointer("/a~"), null);
  assert.equal(parsePointer("/__proto__"), null);
  assert.equal(parsePointer("/constructor/prototype"), null);
  assert.equal(parsePointer("/" + Array(PACK_LIMITS.maxPointerSegments + 1).fill("a").join("/")), null);
  const doc = { a: { b: [10, 20, { c: "x" }] }, "k/ey": 1 };
  assert.equal(pointerGet(doc, "/a/b/2/c"), "x");
  assert.equal(pointerGet(doc, "/a/b/1"), 20);
  assert.equal(pointerGet(doc, "/a/b/01"), undefined);
  assert.equal(pointerGet(doc, "/a/b/-"), undefined);
  assert.equal(pointerGet(doc, "/k~1ey"), 1);
  assert.equal(pointerGet(doc, "/toString"), undefined, "inherited property is not data");
  assert.equal(pointerGet(doc, "/a/__proto__"), undefined);
  assert.equal(pointerGet(JSON.parse('{"__proto__":{"x":1}}'), "/__proto__/x"), undefined);
  assert.deepEqual(parseBinding("feed:/a/b"), { source: "feed", pointer: "/a/b" });
  assert.equal(parseBinding("Feed:/a"), null);
  assert.equal(parseBinding(":/a"), null);
  assert.equal(parseBinding("feed"), null);
  const docs: PackDocuments = { feed: { a: 1 }, status: { feed: { present: true } } };
  assert.equal(resolveBinding("feed:/a", docs), 1);
  assert.equal(resolveBinding("status:/feed/present", docs), true);
  assert.equal(resolveBinding("nope:/a", docs), undefined);
});

test("documentWithinLimits bounds depth, nodes, string size, and rejects prototype keys", () => {
  assert.equal(documentWithinLimits({ a: 1 }), true);
  assert.equal(documentWithinLimits([]), false);
  assert.equal(documentWithinLimits("x"), false);
  let deep: unknown = 1;
  for (let i = 0; i < PACK_LIMITS.maxDepth + 2; i++) deep = { d: deep };
  assert.equal(documentWithinLimits(deep), false);
  assert.equal(documentWithinLimits({ s: "x".repeat(PACK_LIMITS.maxStringChars + 1) }), false);
  assert.equal(documentWithinLimits({ arr: Array.from({ length: PACK_LIMITS.maxNodes + 1 }, () => 0) }), false);
  assert.equal(documentWithinLimits(JSON.parse('{"__proto__":{"x":1}}')), false);
});

test("paintValue formats without inventing; switch picks the first matching case", () => {
  const docs: PackDocuments = {
    feed: { watts: 65.7, writer: true, step: 84960, big: 2_087_976_960, path: "/a/b/latest.json", name: "NVIDIA GB10", parked: true, none: null, ids: [] },
    status: { feed: { present: true, asOf: new Date(Date.now() - 19_000).toISOString() } },
  };
  assert.equal(paintValue({ of: "feed:/watts", fmt: "watts" }, docs), "66 W");
  assert.equal(paintValue({ of: "feed:/writer", fmt: "writer" }, docs), "one");
  assert.equal(paintValue({ of: "feed:/step", fmt: "int", prefix: "step " }, docs), "step 84,960");
  assert.equal(paintValue({ of: "feed:/big", fmt: "tokens" }, docs), "2.09B");
  assert.equal(paintValue({ of: "feed:/path", fmt: "basename" }, docs), "latest.json");
  assert.equal(paintValue({ of: "feed:/name", fmt: "strip", strip: "NVIDIA " }, docs), "GB10");
  assert.equal(paintValue({ of: "feed:/parked", fmt: "map", map: { true: "parked", false: "up" } }, docs), "parked");
  assert.equal(paintValue({ of: "feed:/none", fmt: "map", map: { true: "x" } }, docs), WORKSHOP_UNKNOWN);
  assert.equal(paintValue({ of: "status:/feed/asOf", fmt: "age" }, docs), "19s ago");
  assert.equal(paintValue({ of: "feed:/missing", fmt: "hours", prefix: "in " }, docs), WORKSHOP_UNKNOWN, "no prefix on unknown");
  assert.equal(paintValue({ value: "literal" }, docs), "literal");
  assert.equal(bindingHas([]), false);
  assert.equal(bindingHas(["a"]), true);
  assert.equal(bindingHas(""), false);
  assert.equal(bindingHas(0), true);
  const sw: Extract<Widget, { w: "switch" }> = {
    w: "switch",
    cases: [
      { when: "feed:/ids", has: true, paint: { w: "note", value: "ids" } },
      { when: "feed:/parked", is: true, paint: { w: "note", value: "parked" } },
    ],
    else: { w: "note", value: "else" },
  };
  assert.deepEqual(pickCase(sw, docs), { w: "note", value: "parked" });
  assert.deepEqual(pickCase({ ...sw, cases: [sw.cases[0]] }, docs), { w: "note", value: "else" });
  assert.equal(pickCase({ w: "switch", cases: [sw.cases[0]] }, docs), undefined);
  assert.equal(ratioPercent(835, 1000), 83.5);
  assert.equal(ratioPercent(5, 0), null);
  assert.equal(ratioPercent(2, 1), 100);
});

test("packSourceUrls builds the exact URLs the confirm screen shows", () => {
  assert.deepEqual(packSourceUrls("https://spark.test/", "box-monitor", { id: "feed", kind: "json", path: "feed", pollMs: 2000, freshMs: 120000, maxBytes: 1 }), ["https://spark.test/workshop/box-monitor/feed"]);
  assert.deepEqual(packSourceUrls("https://spark.test", "job-log", { id: "feed", kind: "json", namespace: "box-monitor", path: "feed", pollMs: 2000, freshMs: 120000, maxBytes: 1 }), ["https://spark.test/workshop/box-monitor/feed"]);
  assert.deepEqual(packSourceUrls("https://spark.test", "box-monitor", { id: "feed", kind: "json", namespace: "v0", path: "feed", pollMs: 2000, freshMs: 120000, maxBytes: 1 }), ["https://spark.test/workshop/v0/feed"]);
  assert.deepEqual(packSourceUrls("https://spark.test", "x", { id: "i", kind: "probes", probes: ["healthz", "models"], pollMs: 5000 }), ["https://spark.test/healthz", "https://spark.test/v1/models"]);
});

test("highestSemverTag prefers releases and ignores junk", () => {
  assert.equal(highestSemverTag(["v1.2.3", "v1.10.0", "v2.0.0-rc.1", "nightly", "1.9.9"]), "v1.10.0");
  assert.equal(highestSemverTag(["v2.0.0-rc.1"]), "v2.0.0-rc.1");
  assert.equal(highestSemverTag(["v2.0.0-rc.1", "v2.0.0"]), "v2.0.0");
  assert.equal(highestSemverTag(["latest"]), null);
});

test("normalizeWorkshopSettings keeps the new shape and turns legacy grant rows off", () => {
  const fingerprints = { feed: '{"kind":"json"}', infer: '{"kind":"probes"}' };
  const out = normalizeWorkshopSettings({
    packs: [
      { id: "box-monitor", on: true, grants: ["read.box.metrics"] },
      { id: "sample", on: true, hostId: "spark", sources: ["feed", "feed", "infer"], sourceFingerprints: fingerprints, version: "1.0.0", contract: 1 },
      { id: "no-host", on: true, sources: ["feed"], sourceFingerprints: { feed: "x" } },
      { id: "no-fp", on: true, hostId: "spark", sources: ["feed"] },
      { id: "Bad", on: true, sources: ["feed"] },
    ],
  });
  assert.deepEqual(out.packs[0], { id: "box-monitor", on: false, sources: [] });
  assert.deepEqual(out.packs[1], {
    id: "sample", on: true, hostId: "spark", sources: ["feed", "infer"],
    sourceFingerprints: fingerprints, version: "1.0.0", contract: 1,
  });
  assert.deepEqual(out.packs[2], { id: "no-host", on: false, sources: [] });
  assert.deepEqual(out.packs[3], { id: "no-fp", on: false, sources: [], hostId: "spark" });
  assert.equal(out.packs.length, 4);
  assert.deepEqual(normalizeWorkshopSettings(undefined), { packs: [] });
});

test("source fingerprints bind grants to descriptors; disablePacksForReconfirm clears On rows", () => {
  const feed = { id: "feed", kind: "json" as const, path: "feed", pollMs: 2000, freshMs: 120000, maxBytes: 65536 };
  const moved = { ...feed, namespace: "v0" };
  const fp = sourceFingerprint("box-monitor", feed);
  assert.equal(grantsMatchFingerprints("box-monitor", [feed], ["feed"], { feed: fp }), true);
  assert.equal(grantsMatchFingerprints("box-monitor", [moved], ["feed"], { feed: fp }), false);
  assert.equal(grantsMatchFingerprints("box-monitor", [feed], ["feed"], undefined), false);
  const disabled = disablePacksForReconfirm({
    packs: [
      { id: "box-monitor", on: true, hostId: "spark", sources: ["feed"], sourceFingerprints: { feed: fp } },
      { id: "job-log", on: true, hostId: "spark", sources: ["feed"], sourceFingerprints: fingerprintsForSources("job-log", [feed], ["feed"]) },
      { id: "other", on: false, sources: [] },
    ],
  }, ["box-monitor", "job-log", "missing"]);
  assert.deepEqual(disabled.reconfirmIds, ["box-monitor", "job-log"]);
  assert.equal(disabled.settings.packs[0]?.on, false);
  assert.equal(disabled.settings.packs[0]?.sourceFingerprints, undefined);
  assert.equal(disabled.settings.packs[1]?.on, false);
  assert.equal(disabled.settings.packs[2]?.on, false);
});

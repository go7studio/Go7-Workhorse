import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WORKSHOP_UNKNOWN,
  parseWorkshopPack,
  paintValue,
  pickCase,
  resolveBinding,
  type Card,
  type PackDocuments,
  type PackView,
  type Value,
  type Widget,
} from "../src/lib/workshop-pack";
import { PaintCard, PaintWidget } from "../src/ui/workshop-paint";
import { WorkshopRail } from "../src/ui/WorkshopRail";
import { clipLog, feedAge, feedTone, flagWords, joinParts, primaryStatus, probeRows } from "../src/ui/workshop-live";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "workshop", "sample-box", "pack.json");
/** The DGX pack lives in its own repo beside this one; the walk skips when that checkout is absent. */
const DGX = path.resolve(ROOT, "..", "workshop-pack-dgx-spark", "packs");

const NOW = Date.parse("2026-09-04T14:00:00.000Z");
const AS_OF = new Date(NOW - 19_000).toISOString();

function loadPack(file: string) {
  const parsed = parseWorkshopPack(JSON.parse(readFileSync(file, "utf8")));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return parsed.pack;
}

/** Documents shaped like the collector's feed plus the host's probe, status, and desk rows. */
function soakDocuments(): PackDocuments {
  return {
    feed: {
      schema: "go7-workshop-feed/v0",
      asOf: AS_OF,
      gpuUtilPercent: 96,
      powerWatts: 65.73,
      oneWriter: true,
      latestJson: "/home/go7-dgx-spark/workloads/llm/checkpoints/base/shared_v3/latest.json",
      exclusiveSidecar: { probeUnit: "active", qwenParked: true },
      job: {
        lease: { kind: "pretrain", pid: 280131, yaml: "configs/mb64_probe_v1.yaml", startedUtc: "2026-09-02 17:47Z" },
        live: { step: 84960, tokensSeen: 2_087_976_960, trainLoss: 2.555, last8TokS: 13653.3, logAsOf: AS_OF },
        durable: {
          step: 80000, tokPerParam: 3.93, targetTokens: 2_500_000_000, targetTokPerParam: 5, tokensPerStep: 24576, paramCount: 500_000_000,
          jobComplete: false, undertrainedFlag: true, runName: "shared_v40_v9_500m_bf16_mb64_probe_v1", savedAt: "2026-09-04T10:56:00.000Z",
        },
        derived: { tokPerParam: 4.176, targetTokPerParam: 5, pct: 83.5, remainTokens: 412_023_040, hoursToFloor: 8.383, secPerIt: 1.8, stepsAhead: 4960 },
        flags: ["gpu-idle"],
        gpuName: "NVIDIA GB10",
      },
      jobLogTail: "step 1\nstep 2\nstep 3",
      // sample-box fields
      loadPercent: 41,
      watts: 220.4,
      unitName: "ACME Box",
      flags: ["idle"],
      logTail: "a\nb",
    },
    infer: {
      healthz: { status: "ok" },
      readyz: { status: "down", detail: "http-502" },
      models: { status: "down", detail: "http-502" },
    },
    status: { feed: { present: true, asOf: AS_OF, fetchedAt: AS_OF }, infer: { present: true } },
    desk: { host: { label: "Spark", emptyCapabilities: false }, pack: { name: "Box monitor" } },
  };
}

const EMPTY: PackDocuments = { status: { feed: { present: false } } };

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node);
}

function paint(widget: Widget, documents: PackDocuments, variant: "strip" | "card" = "card"): string {
  return render(createElement(PaintWidget, { widget, documents, now: NOW, variant }));
}

function paintCard(card: Card, documents: PackDocuments): string {
  return render(createElement(PaintCard, { card, documents, now: NOW }));
}

/** Resolve every binding a widget names; a pure walk that mirrors what the renderer touches. */
function walk(widget: Widget, documents: PackDocuments): void {
  const value = (spec: Value | Partial<Value> | undefined) => {
    if (!spec) return;
    if ("value" in spec) return;
    if (typeof (spec as { of?: unknown }).of === "string") paintValue(spec as Value, documents, NOW);
  };
  switch (widget.w) {
    case "ring": resolveBinding(widget.of, documents); break;
    case "bar": resolveBinding(widget.num, documents); resolveBinding(widget.den, documents); break;
    case "text": value(widget); value(widget.title); break;
    case "kv": widget.parts?.forEach(value); value(widget); value(widget.title); break;
    case "pair": value(widget.a); value(widget.a.sub); value(widget.b); value(widget.b.sub); break;
    case "meta": widget.parts.forEach(value); value(widget.title); break;
    case "note": break;
    case "chips": resolveBinding(widget.of, documents); break;
    case "probes": probeRows((documents as Record<string, unknown>)[widget.of]); break;
    case "flags": flagWords(resolveBinding(widget.of, documents), widget.words); break;
    case "log": clipLog(resolveBinding(widget.of, documents), widget.lines); break;
    case "hbox": widget.children.forEach((child) => walk(child, documents)); break;
    case "switch": {
      const chosen = pickCase(widget, documents);
      if (chosen) walk(chosen, documents);
      break;
    }
  }
}

function packFiles(): string[] {
  const files = [FIXTURE];
  for (const id of ["box-monitor", "job-log"]) {
    const file = path.join(DGX, id, "pack.json");
    if (existsSync(file)) files.push(file);
  }
  return files;
}

test("every widget in the fixture and DGX packs resolves and paints against soak and empty documents", () => {
  for (const file of packFiles()) {
    const pack = loadPack(file);
    for (const documents of [soakDocuments(), EMPTY]) {
      for (const widget of pack.strip) {
        assert.doesNotThrow(() => walk(widget, documents), `${pack.id} strip`);
        assert.doesNotThrow(() => paint(widget, documents, "strip"), `${pack.id} strip paint`);
      }
      for (const card of pack.cards) {
        if (card.aside) assert.doesNotThrow(() => walk(card.aside!, documents), `${pack.id} ${card.title} aside`);
        for (const row of card.rows) assert.doesNotThrow(() => walk(row, documents), `${pack.id} ${card.title}`);
        const html = paintCard(card, documents);
        assert.match(html, /class="workshop-card"/);
        assert.match(html, new RegExp(`section-label">${card.title}`), `${pack.id} ${card.title} heading`);
      }
    }
  }
});

test("the DGX box-monitor cards paint the soak values the rail shows today", (t) => {
  const file = path.join(DGX, "box-monitor", "pack.json");
  if (!existsSync(file)) return t.skip("workshop-pack-dgx-spark checkout not beside this repo");
  const pack = loadPack(file);
  const documents = soakDocuments();
  const byTitle = (title: string) => paintCard(pack.cards.find((card) => card.title === title)!, documents);

  const box = byTitle("Box");
  assert.match(box, /class="workshop-box"/);
  assert.match(box, /aria-label="96%"/);
  assert.match(box, /66 W/);
  assert.match(box, /workshop-dot-ok/);
  assert.match(box, />GB10</);

  const models = byTitle("Models");
  assert.match(models, /section-label">Models</);
  assert.doesNotMatch(models, /Models · /);
  assert.match(models, /workshop-chip-mute[^>]*>train exclusive</);
  assert.match(models, /infer down \/ train exclusive · http-502/);
  // Collapsed strip keeps the short exclusive line; detail stays on the Models card.
  const exclusive = pack.strip.find((w) => w.w === "switch")!;
  const stripExclusive = paint(exclusive, documents, "strip");
  assert.match(stripExclusive, /workshop-rail-models[^>]*>infer down \/ train exclusive</);
  assert.doesNotMatch(stripExclusive, /http-502/);

  const infer = byTitle("Infer");
  assert.match(infer, /healthz · up.*readyz · down.*v1\/models · down/s);
  assert.match(infer, /row-meta">readyz · http-502/);

  const router = byTitle("Router");
  assert.match(router, /nvidia-spark-train-infer/);
  assert.match(router, />active</);
  assert.match(router, />parked</);
  assert.match(router, /workshop-law">labels only, never route\/lease\/start\/stop/);

  const job = byTitle("Job");
  assert.match(job, /Job · <span class="workshop-label-name">Bloom soak<\/span>/);
  assert.match(job, /mb64_probe_v1\.yaml · pretrain · pid 280131 · 44 h/);
  assert.match(job, /width:83\.5\d*%/);
  assert.match(job, />83\.5%</);
  assert.match(job, />4\.18<.*\/ 5\.0 tok\/param/s);
  assert.match(job, />2\.09B<.*\/ 2\.50B tokens/s);
  assert.match(job, />84,960 · loss 2\.56</);
  assert.match(job, />80,000 · 3\.93 tpp · \d\d:\d\d</);
  assert.match(job, />13,653 tok\/s · 1\.8 s\/it</);
  assert.match(job, />8\.4 h</);
  assert.match(job, />running \(one writer\)</);
  assert.match(job, />undertrained</);
  assert.match(job, />latest\.json</);
  assert.match(job, /workshop-chip-warn[^>]*>gpu idle</);

  const feed = byTitle("Feed");
  assert.match(feed, /present · 19s ago/);
});

test("a pack whose sources are absent paints every slot as a dash and keeps the card", (t) => {
  const file = path.join(DGX, "box-monitor", "pack.json");
  if (!existsSync(file)) return t.skip("workshop-pack-dgx-spark checkout not beside this repo");
  const pack = loadPack(file);
  const job = paintCard(pack.cards.find((card) => card.title === "Job")!, EMPTY);
  assert.match(job, /section-label">Job</);
  assert.doesNotMatch(job, /Bloom soak/);
  assert.match(job, /workshop-bar is-unknown/);
  const dashes = job.split(WORKSHOP_UNKNOWN).length - 1;
  assert.ok(dashes >= 10, `expected a dash per slot, saw ${dashes}`);
  const feed = paintCard(pack.cards.find((card) => card.title === "Feed")!, EMPTY);
  assert.match(feed, /Feed not present\. Every meter is —\. This desk does not remote-install\./);
  const infer = paintCard(pack.cards.find((card) => card.title === "Infer")!, EMPTY);
  assert.match(infer, /healthz · —.*readyz · —.*v1\/models · —/s);
});

test("kv parts join the known parts with a dot and collapse to one dash when all are unknown", () => {
  const documents: PackDocuments = { feed: { a: 1, b: "two" } };
  assert.equal(joinParts([{ of: "feed:/a", fmt: "int" }, { of: "feed:/b" }], documents, NOW), "1 · two");
  assert.equal(joinParts([{ of: "feed:/a", fmt: "int" }, { of: "feed:/missing" }], documents, NOW), "1");
  assert.equal(joinParts([{ of: "feed:/missing" }, { of: "feed:/gone", fmt: "clock" }], documents, NOW), WORKSHOP_UNKNOWN);
  const html = paint({ w: "kv", label: "Live", parts: [{ of: "feed:/a", fmt: "int" }, { of: "feed:/missing", prefix: "loss " }] }, documents);
  assert.match(html, /<span>Live<\/span><strong>1<\/strong>/);
});

test("probes paint healthz, readyz, v1/models in that order with the first detail under them", () => {
  const rows = probeRows({ models: { status: "down", detail: "http-502" }, healthz: { status: "ok" }, readyz: { status: "unauthorized", detail: "http-401" } });
  assert.deepEqual(rows.map((row) => row.label), ["healthz", "readyz", "v1/models"]);
  assert.deepEqual(rows.map((row) => row.status), ["up", "unauthorized", "down"]);
  assert.deepEqual(rows.map((row) => row.tone), ["ok", "warn", "mute"]);
  assert.deepEqual(probeRows(undefined).map((row) => `${row.label} · ${row.status}`), ["healthz · —", "readyz · —", "v1/models · —"]);
  const html = paint({ w: "probes", of: "infer" }, { infer: { healthz: { status: "ok" }, readyz: { status: "down", detail: "http-502" }, models: { status: "down", detail: "http-503" } } });
  assert.match(html, /row-meta">readyz · http-502</);
  assert.doesNotMatch(html, /http-503</);
});

test("log clips to the last N lines and paints a dash when the tail is missing", () => {
  assert.equal(clipLog("a\nb\nc\nd\n", 2), "c\nd");
  assert.equal(clipLog("a\r\nb\r\nc", 5), "a\nb\nc");
  assert.equal(clipLog(undefined, 3), WORKSHOP_UNKNOWN);
  assert.equal(clipLog("   ", 3), WORKSHOP_UNKNOWN);
  const html = paint({ w: "log", of: "feed:/tail", lines: 2 }, { feed: { tail: "one\ntwo\nthree" } });
  assert.match(html, /<pre class="workshop-log">two\nthree<\/pre>/);
  assert.doesNotMatch(html, />one\n/);
});

test("flags map through the pack's words; the strip says one flag or a count", () => {
  const words = { "gpu-idle": "gpu idle", "two-trainers": "two trainers" };
  assert.deepEqual(flagWords(["gpu-idle", "mystery"], words), ["gpu idle", "mystery"]);
  assert.deepEqual(flagWords("gpu-idle", words), []);
  const documents: PackDocuments = { feed: { flags: ["gpu-idle", "two-trainers"] } };
  const card = paint({ w: "flags", of: "feed:/flags", words }, documents);
  assert.match(card, /workshop-chip-warn[^>]*>gpu idle<.*workshop-chip-warn[^>]*>two trainers</s);
  const strip = paint({ w: "flags", of: "feed:/flags", words }, documents, "strip");
  assert.match(strip, /workshop-tone-warn.*2 flags/s);
  assert.equal(paint({ w: "flags", of: "feed:/flags", words }, { feed: { flags: [] } }), "");
});

test("switch paints the chosen branch or nothing; a card title grows a name only when it resolves", () => {
  const widget: Widget = {
    w: "switch",
    cases: [{ when: "feed:/done", is: true, paint: { w: "text", value: "complete" } }],
    else: { w: "text", value: "open" },
  };
  assert.match(paint(widget, { feed: { done: true } }), />complete</);
  assert.match(paint(widget, { feed: { done: false } }), />open</);
  assert.equal(paint({ w: "switch", cases: [{ when: "feed:/x", has: true, paint: { w: "note", value: "x" } }] }, {}), "");
  const card: Card = { title: "Models", name: { of: "infer:/models/count", fmt: "int" }, rows: [{ w: "note", value: "n" }] };
  assert.match(paintCard(card, { infer: { models: { count: 2 } } }), /Models · <span class="workshop-label-name">2</);
  assert.match(paintCard(card, {}), /section-label">Models<\/div>/);
});

test("primaryStatus reads the first json source's status row; the feed chip tones from it", () => {
  const view: PackView = {
    id: "p", name: "P", version: "1.0.0", contract: 1, description: "", on: true, strip: [], cards: [],
    primarySource: "feed",
    documents: { status: { feed: { present: true, asOf: AS_OF }, infer: { present: false } } },
  };
  assert.deepEqual(primaryStatus(view), { present: true, asOf: AS_OF });
  assert.equal(primaryStatus({ ...view, primarySource: undefined }), undefined);
  assert.equal(primaryStatus({ ...view, documents: {} }), undefined);
  assert.equal(feedTone(primaryStatus(view)), "ok");
  assert.equal(feedAge(primaryStatus(view), NOW), "19s ago");
  assert.equal(feedTone({ present: false, reason: "stale", asOf: AS_OF }), "warn");
  assert.equal(feedTone({ present: false, reason: "unreachable" }), "warn");
  assert.equal(feedTone({ present: false, reason: "off" }), "mute");
  assert.equal(feedTone(undefined), "mute");
  assert.equal(feedAge(undefined, NOW), "off");
  assert.equal(feedAge({ present: false, reason: "unreachable" }, NOW), "unreachable");
});

test("the rail formats document values and never computes from them; it paints no control that changes the box", () => {
  for (const rel of ["src/ui/WorkshopRail.tsx", "src/ui/workshop-paint.tsx", "src/ui/WorkshopBreakout.tsx", "src/ui/workshop-live.ts"]) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    assert.doesNotMatch(src, /resolveBinding\([^)]*\)\s*[-+*/]/, `${rel}: arithmetic on a document value`);
    assert.doesNotMatch(src, /\b(Start|Stop|Turn off)\b/, `${rel}: a control word`);
    assert.doesNotMatch(src, /workshopRead|workshopFeedStatus|deriveJob|from "\.\.\/lib\/workshop"/, `${rel}: legacy read path`);
    assert.doesNotMatch(src, /sparkline|history|series/i, rel);
  }
  const rail = readFileSync(path.join(ROOT, "src", "ui", "WorkshopRail.tsx"), "utf8");
  assert.match(rail, /workshopView|useWorkshopLive/);
  assert.match(rail, /workshopOpenBreakout/);
  const paint = readFileSync(path.join(ROOT, "src", "ui", "workshop-paint.tsx"), "utf8");
  assert.match(paint, /ratioPercent\(/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  const start = css.indexOf("/* Workshop — a read-only add-on rail");
  const end = css.indexOf(".workshop-settings {", start);
  assert.ok(start >= 0 && end > start, "workshop css block present");
  const block = css.slice(start, end);
  assert.doesNotMatch(block, /--hairline/);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i);
  assert.match(block, /\.workshop-pack-strip \+ \.workshop-pack-strip|\* \+ \.workshop-pack-strip/);
});

test("create refuse switch paints refuseReason when create.allowed is false", () => {
  const widget: Widget = {
    w: "switch",
    cases: [
      { when: "feed:/create/allowed", is: false, paint: { w: "kv", label: "Create", of: "feed:/create/refuseReason" } },
      { when: "feed:/create/allowed", is: true, paint: { w: "chips", of: "feed:/create/templateLabels", tone: "mute" } },
    ],
    else: { w: "text", value: "—" },
  };
  const refused = paint(widget, {
    feed: {
      create: {
        allowed: false,
        refuseReason: "infer down / train exclusive — create paused",
        templateLabels: ["Flux still"],
      },
    },
  });
  assert.match(refused, /infer down \/ train exclusive — create paused/);
  assert.doesNotMatch(refused, /Flux still/);
  const allowed = paint(widget, {
    feed: {
      create: {
        allowed: true,
        refuseReason: "",
        templateLabels: ["Flux still"],
      },
    },
  });
  assert.match(allowed, /Flux still/);
});

test("gallery paints kind chip, label, and path actions", () => {
  const html = paint(
    { w: "gallery", of: "feed:/outputs", limit: 8 },
    {
      feed: {
        outputs: [
          { kind: "image", label: "still.png", path: "/tmp/still.png" },
          { kind: "video", label: "clip.mp4" },
        ],
      },
    },
  );
  assert.match(html, /workshop-gallery/);
  assert.match(html, />image</);
  assert.match(html, /still\.png/);
  assert.match(html, />Open</);
  assert.match(html, />Reveal</);
  assert.match(html, /No local path/);
});

test("empty / all-Off rail paints thin stub with single Add packs CTA (cold desk)", () => {
  const html = render(createElement(WorkshopRail));
  assert.match(html, /aria-label="Workshop rail"/);
  assert.match(html, /is-empty|workshop-rail-empty-stub/);
  assert.match(html, /Add packs/);
  assert.match(html, /aria-label="Add packs"/);
  assert.doesNotMatch(html, /Install a pack/);
  // Single empty CTA only — no Manage + Install duplicate on the stub.
  assert.doesNotMatch(html, />Manage</);
  assert.doesNotMatch(html, /workshop-manage-sheet/);
});

test("rail source always exposes Manage on collapsed/expanded; empty uses Add packs; sheet is Manage packs", () => {
  const rail = readFileSync(path.join(ROOT, "src", "ui", "WorkshopRail.tsx"), "utf8");
  assert.match(rail, /is-empty/);
  assert.match(rail, /Add packs/);
  assert.match(rail, /workshop-rail-add-packs/);
  assert.match(rail, /"Turn on"/);
  assert.match(rail, /workshop-rail-turn-on/);
  assert.match(rail, /workshop-rail-manage/);
  assert.match(rail, /ManageSheet/);
  assert.match(rail, /surface="sheet"/);
  assert.match(rail, /focusAvailable=\{availableFirst\}/);
  assert.match(rail, /aria-label="Manage packs"/);
  assert.match(rail, />Manage packs</);
  assert.match(rail, /workshop-manage-sheet/);
  assert.match(rail, /workshop-manage-drawer/);
  assert.match(rail, /aria-modal="false"/);
  assert.doesNotMatch(rail, /aria-modal="true"/);
  assert.doesNotMatch(rail, /sheet-backdrop workshop-manage-backdrop/);
  assert.match(rail, /Escape/);
  assert.match(rail, /FOCUSABLE|focusables/);
  assert.match(rail, /restore\.focus|openerRef/);
  assert.match(rail, /do not trap Tab away from chat/);
  assert.doesNotMatch(rail, /if \(on\.length === 0\) return null/);
  assert.doesNotMatch(rail, /Install a pack/);
  // ManageButton on collapsed + expanded (+ def); empty path uses Add packs instead.
  const manageHits = rail.split("ManageButton").length - 1;
  assert.ok(manageHits >= 3, `expected ManageButton on collapsed + expanded (+ def), saw ${manageHits}`);
  assert.doesNotMatch(rail, /UsagePane|WatchPane|setSettingsSection\("workshop"\)/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(css, /\.workshop-rail\.is-empty\s*\{[^}]*width:\s*60px/s);
  assert.match(css, /min-height:\s*56px/);
  assert.match(css, /max-height:\s*64px/);
  assert.doesNotMatch(css, /\.workshop-rail\.is-empty\s*\{[^}]*width:\s*96px/s);
  assert.match(css, /\.workshop-manage-drawer\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /backdrop-filter:\s*none/);
  assert.match(css, /\.workshop-manage-sheet\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(css, /workshop-blurb/);
  assert.match(css, /workshop-pack-summary/);
  assert.match(css, /workshop-pack-mark/);
  assert.match(css, /workshop-row-hit/);
  assert.match(css, /\.pack-list/);
  assert.match(css, /\.pack-row/);
  assert.match(css, /workshop-sources-label/);
});

test("WorkshopBlock sheet hides link-head; Active/Pending accordion; Retry only on failure; Advanced peer Add", () => {
  const block = readFileSync(path.join(ROOT, "src", "ui", "WorkshopBlock.tsx"), "utf8");
  // surface=sheet skips link-head / Workshop title (Manage packs is the one title).
  assert.match(block, /inSheet \? \(/);
  assert.match(block, /link-head/);
  assert.match(block, /Install a pack, then Turn on\./);
  assert.match(block, /id="workshop-active"/);
  assert.match(block, /id="workshop-pending"/);
  assert.match(block, />\s*Active\s*</);
  assert.match(block, />\s*Pending\s*</);
  assert.match(block, /expandedId/);
  assert.match(block, /toggleExpanded/);
  assert.match(block, /workshop-row-hit/);
  assert.match(block, /workshop-pack-mark/);
  assert.match(block, /activeRef|pendingRef/);
  assert.match(block, /className="tiny primary"/);
  assert.match(block, /needsUpdate \? "Update" : "Install"/);
  assert.match(block, /Add local/);
  assert.match(block, /Add from URL/);
  assert.match(block, /workshop-peer-add/);
  assert.match(block, /Local \(Advanced\)/);
  // Exactly one Retry button label — only in the real catalog failure branch.
  const retryLabels = block.match(/>\s*Retry\s*</g) ?? [];
  assert.equal(retryLabels.length, 1, `expected one Retry label, saw ${retryLabels.length}`);
  assert.match(block, /Catalog unreachable[\s\S]*Retry/);
  assert.doesNotMatch(block, /No packs in catalog[\s\S]{0,160}Retry/);
  assert.match(block, /workshop-pack-summary/);
});

test("ADV A–F: all-Off honesty, Remove confirm, Available name, sheet Detach hide, Refresh when healthy", () => {
  const rail = readFileSync(path.join(ROOT, "src", "ui", "WorkshopRail.tsx"), "utf8");
  const block = readFileSync(path.join(ROOT, "src", "ui", "WorkshopBlock.tsx"), "utf8");
  // A: zero installed → Add packs; installed all-Off → Turn on (not Install).
  assert.match(rail, /"Turn on"/);
  assert.match(rail, /availableFirst: zeroInstalled/);
  assert.match(rail, /workshop-rail-turn-on/);
  assert.match(rail, /workshopList/);
  assert.match(rail, /zeroInstalled/);
  assert.doesNotMatch(rail, /Install a pack/);
  // B: Remove requires confirm step.
  assert.match(block, /removeConfirmId/);
  assert.match(block, /Confirm remove/);
  assert.match(block, /setRemoveConfirmId\(pack\.id\)/);
  // C: Pending catalog shows catalogDisplayName; id only in expanded meta.
  assert.match(block, /catalogDisplayName\(entry\.id\)/);
  assert.match(block, /vLabel\(entry\.version\)\} · \{entry\.id\}/);
  // D: Detach only in settings link-head (hidden when surface=sheet).
  assert.match(block, /surface="sheet"|inSheet/);
  assert.match(block, /Detach is Settings \/ live-rail only/);
  const detachHits = block.match(/>\s*Detach\s*</g) ?? [];
  assert.equal(detachHits.length, 1, `expected one Detach label in settings path, saw ${detachHits.length}`);
  // F: Refresh on healthy catalog (settings toolbar / empty CTA); Retry only on failure.
  // Sheet head Refresh is in WorkshopRail — never between Pending rows.
  const refreshLabels = block.match(/>\s*Refresh\s*</g) ?? [];
  assert.ok(refreshLabels.length >= 1, "expected Refresh when catalog healthy");
  assert.match(block, /No packs in catalog[\s\S]{0,200}Refresh/);
  assert.match(block, /workshop-manage-toolbar[\s\S]*Refresh/);
  assert.doesNotMatch(block, /workshop-catalog-toolbar/);
  assert.match(rail, /workshop-manage-sheet-head-actions[\s\S]*Refresh/);
  assert.match(rail, /catalogRefreshNonce/);
});

test("simple rows: Active/Pending accordion, no default essays, hide same-version, URL title, Detach while Manage, rail clamp", () => {
  const block = readFileSync(path.join(ROOT, "src", "ui", "WorkshopBlock.tsx"), "utf8");
  const railSrc = readFileSync(path.join(ROOT, "src", "ui", "WorkshopRail.tsx"), "utf8");
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  const paint = readFileSync(path.join(ROOT, "src", "ui", "workshop-paint.tsx"), "utf8");
  // 1: Collapsed Active/Pending = mark + title; catalog summary only in expand (Active drops essay).
  assert.match(block, /workshop-pack-mark/);
  assert.match(block, /workshop-row-title/);
  assert.match(block, /workshop-pack-summary/);
  assert.match(block, /expandedId/);
  assert.doesNotMatch(block, /workshop-pack-desc/);
  assert.doesNotMatch(block, />Installed</);
  assert.doesNotMatch(block, />Available</);
  assert.match(block, /Packs on this desk/);
  // 2: Collector · Reveal only under quiet More (not default expand essay).
  assert.match(block, /Collector · Reveal/);
  assert.doesNotMatch(block, /Collector: installed by the operator on the remote box/);
  assert.match(block, /workshop-row-more[\s\S]*Collector · Reveal/);
  assert.match(block, />More</);
  // 3: Pending hides same-version Installed (Update/yanked still shown).
  assert.match(block, /Hide same-version Installed/);
  assert.match(block, /installed\.version !== entry\.version/);
  assert.doesNotMatch(block, /Already on this desk/);
  // 4: Turn-on URL truncated; full URL in title.
  assert.match(block, /shortSourceUrl\(line\)/);
  assert.match(block, /title=\{line\}/);
  // 5: Rail Detach hidden while Manage sheet open.
  assert.match(railSrc, /!manageOpen/);
  assert.match(railSrc, /Hide Detach while Manage is open/);
  // 6: Expanded null-feed note softens to one line (full text in title) — rail soak unchanged.
  assert.match(css, /\.workshop-rail \.workshop-law[^{]*\{[^}]*line-clamp:\s*1/s);
  assert.match(paint, /className="row-meta workshop-law" title=\{widget\.value\}/);
});

test("feel pass: quiet marks/headers, Refresh not between rows, Pending action align, Advanced whisper", () => {
  const block = readFileSync(path.join(ROOT, "src", "ui", "WorkshopBlock.tsx"), "utf8");
  const railSrc = readFileSync(path.join(ROOT, "src", "ui", "WorkshopRail.tsx"), "utf8");
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  // Active expand: host · sources + actions; no default summary / provenance essay.
  assert.doesNotMatch(block, /from folder/);
  assert.doesNotMatch(block, /from catalog · this desk/);
  // Refresh: sheet head + settings toolbar; never catalog-toolbar between Pending rows.
  assert.match(railSrc, /workshop-manage-sheet-head-actions/);
  assert.match(railSrc, /catalogRefreshNonce/);
  assert.match(block, /workshop-manage-toolbar/);
  assert.doesNotMatch(block, /workshop-catalog-toolbar/);
  assert.doesNotMatch(css, /workshop-catalog-toolbar/);
  // Quieter letter marks (small muted circle).
  assert.match(css, /\.workshop-pack-mark\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(css, /\.workshop-pack-mark\s*\{[^}]*width:\s*20px/s);
  // Section-label Active/Pending headers.
  assert.match(block, /workshop-section-title section-label/);
  assert.match(css, /workshop-section-title\.section-label/);
  // Pending action column alignment; Install primary; Turn on quiet.
  assert.match(css, /workshop-row-action-slot/);
  assert.match(block, /workshop-turn-on-quiet/);
  assert.match(block, /className="tiny primary"/);
  // Advanced whisper.
  assert.match(css, /workshop-advanced-toggle/);
  assert.match(block, /workshop-advanced-toggle/);
  assert.doesNotMatch(block, /workshop-section-title workshop-advanced-title/);
});


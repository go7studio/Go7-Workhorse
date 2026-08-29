import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LINEUP_FINISHED_NOTICE } from "../src/lib/lineup";
import { workerTaskTitle } from "../src/lib/subagents";
import { crewDoneKind } from "../src/ui/SessionPane";
import { workerFoldLabel } from "../src/ui/WorkPopout";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

test("work-fold labels use the nested sidebar identity, not a slice fragment", () => {
  assert.equal(
    workerFoldLabel({ fromTitle: "Certify Saga candidate", text: "Certify Saga candidate" }, { title: "Barnaby · Certify Saga candidate", workerName: "Barnaby" }),
    "Barnaby · Certify Saga candidate",
  );
  assert.equal(
    workerFoldLabel({ fromTitle: "Menu open close blur", text: "Menu open close blur" }, { workerName: "Casper" }),
    workerTaskTitle("Casper", "Menu open close blur"),
  );
  assert.equal(workerFoldLabel({ text: "Grok" }, null), "Grok");
  const popout = read("src/ui/WorkPopout.tsx");
  assert.match(popout, /workerFoldLabel\(marker, child\)/);
  assert.match(popout, /from \"\.\.\/lib\/subagents\"/);
  assert.doesNotMatch(popout, /marker\.fromTitle \|\| marker\.text \|\| child\?\.title/);
});

test("failed tool and crew-done copy use danger, not tertiary gray", () => {
  assert.equal(crewDoneKind(LINEUP_FINISHED_NOTICE), "ok");
  assert.equal(crewDoneKind("1 of 2 workers finished · 1 failed."), "bad");
  assert.equal(crewDoneKind("No worker finished · 1 interrupted."), "bad");
  assert.equal(crewDoneKind("1 of 2 workers finished · 1 cancelled."), "bad");
  assert.equal(crewDoneKind("Allowed once"), null);
  const pane = read("src/ui/SessionPane.tsx");
  const popout = read("src/ui/WorkPopout.tsx");
  const css = read("src/styles/app.css");
  assert.match(pane, /crew-done\$\{crew === "bad" \? " failed" : ""\}/);
  assert.match(popout, /tool-status\$\{failed \? " failed" : ""\}/);
  assert.match(css, /\.tool-status\.failed\s*\{[^}]*var\(--danger\)/);
  assert.match(css, /\.tool-line\.failed\s*\{[^}]*var\(--danger\)/);
  assert.match(css, /\.crew-done\.failed \.crew-done-card strong\s*\{[^}]*var\(--danger\)/);
});

test("subagent names keep a real min-width and wrap instead of shrinking to an ellipsis", () => {
  const css = read("src/styles/app.css");
  const name = css.slice(css.search(/^\.tool-name \{/m), css.search(/^\.tool-status \{/m));
  assert.match(name, /min-width:\s*8ch/);
  assert.match(name, /max-width:\s*28ch/);
  assert.match(name, /text-overflow:\s*ellipsis/);
  const open = css.slice(css.search(/^\.subagent-open \{/m), css.search(/^\.subagent-open \.tool-name \{/m));
  assert.match(open, /flex-wrap:\s*wrap/);
  const subName = css.slice(css.search(/^\.subagent-open \.tool-name \{/m), css.search(/^\.subagent-model \{/m));
  assert.match(subName, /min-width:\s*12ch/);
  assert.match(subName, /white-space:\s*normal/);
  assert.doesNotMatch(subName, /text-overflow:\s*ellipsis/);
});

test("wide markdown tables can exceed the wrap so overflow-x actually scrolls", () => {
  const css = read("src/styles/app.css");
  const wrap = css.slice(css.search(/^\.md-table-wrap \{/m), css.search(/^\.md-table \{/m));
  assert.match(wrap, /overflow-x:\s*auto/);
  assert.match(wrap, /max-width:\s*100%/);
  const table = css.slice(css.search(/^\.md-table \{/m), css.search(/^\.md-table th,/m));
  assert.match(table, /width:\s*100%/);
  assert.match(table, /min-width:\s*max-content/);
});

test("an open Changes chip pads the transcript so it stays off the last markdown", () => {
  const pane = read("src/ui/SessionPane.tsx");
  const css = read("src/styles/app.css");
  assert.match(pane, /editsBarOpen \? " has-changes"/);
  const transcript = css.slice(css.search(/^\.transcript \{/m), css.search(/^\.transcript\.follow-latest \{/m));
  assert.match(transcript, /padding:\s*28px 22px 20px/);
  assert.match(transcript, /\.transcript\.has-changes\s*\{[^}]*padding-bottom:\s*68px/);
  assert.match(css, /\.session-edits-slot\.open[\s\S]*bottom:\s*calc\(var\(--composer-input, 80px\) \+ var\(--notices-dock, 0px\) \+ 16px\)/);
});

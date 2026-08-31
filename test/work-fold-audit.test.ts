import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LINEUP_FINISHED_NOTICE } from "../src/lib/lineup";
import { subagentTurns, workerTaskTitle } from "../src/lib/subagents";
import { displayWorkSteps, groupTranscript } from "../src/lib/turns";
import { crewDoneKind } from "../src/ui/SessionPane";
import { workerFoldLabel } from "../src/ui/WorkPopout";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** One top-level rule. Empty match must fail — adjacent-slice tests can pass on the wrong block. */
function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[0];
}

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

test("a closed nested worker fold does not keep padding that leaks the peer bubble", () => {
  const css = read("src/styles/app.css");
  const slot = cssBlock(css, ".subagent-thread-slot");
  assert.match(slot, /grid-template-rows:\s*0fr/);
  assert.match(slot, /overflow:\s*hidden/);
  const inner = cssBlock(css, ".subagent-thread-slot > .subagent-thread");
  assert.match(inner, /min-height:\s*0/);
  assert.match(inner, /overflow:\s*hidden/);
  // Same grid item as .subagent-thread — padding here restores the slab and used to miss this rule.
  assert.doesNotMatch(inner, /padding/);
  assert.doesNotMatch(inner, /margin/);
  const thread = cssBlock(css, ".subagent-thread");
  assert.match(thread, /margin:\s*0/);
  assert.match(thread, /padding:\s*0/);
  assert.match(thread, /gap:\s*0/);
  assert.doesNotMatch(thread, /padding(?:-top|-bottom|-left|-right|-block|-inline)?\s*:[^;]*[1-9]/);
  assert.doesNotMatch(thread, /margin(?:-top|-bottom|-left|-right|-block|-inline)?\s*:[^;]*[1-9]/);
  assert.doesNotMatch(thread, /gap:\s*10px/);
  const openThread = cssBlock(css, ".subagent-preview.open .subagent-thread");
  assert.match(openThread, /padding:\s*8px 0 2px/);
  assert.match(openThread, /margin:\s*8px 0 4px/);
  assert.match(openThread, /gap:\s*10px/);
  const openSlot = cssBlock(css, ".subagent-preview.open .subagent-thread-slot");
  assert.match(openSlot, /grid-template-rows:\s*1fr/);
});

test("nested worker preview skips thoughts and tools; those stay on the worker chat", () => {
  const turns = subagentTurns(
    {
      messages: [
        { id: "brief", role: "user", kind: "peer", fromTitle: "Grok", text: "Fix the path", createdAt: 1 },
        { id: "think", role: "assistant", kind: "thought", text: "I should inspect default.ts", createdAt: 2 },
        { id: "tool", role: "system", kind: "tool", text: "Read · default.ts", createdAt: 3 },
        { id: "compact", role: "system", kind: "compact", text: "trimmed", createdAt: 4 },
        { id: "mark", role: "system", kind: "subagent", text: "Marlow", createdAt: 5 },
        { id: "empty-user", role: "user", kind: "peer", fromTitle: "Grok", text: "  ", createdAt: 6 },
        { id: "say", role: "assistant", text: "Done.", createdAt: 7 },
        { id: "draft", role: "assistant", text: "", createdAt: 8 },
      ],
    },
    0,
  );
  assert.deepEqual(
    turns.map((turn) => turn.id),
    ["brief", "say", "draft"],
  );
  assert.equal(turns[0]?.fromTitle, "Grok");
});

test("empty parent thoughts never become a work row that could look like a bar", () => {
  const blocks = groupTranscript([
    { id: "u", role: "user", text: "go", createdAt: 1 },
    { id: "a", role: "assistant", text: "ok", thought: "   ", createdAt: 2 },
    { id: "t", role: "assistant", kind: "thought", text: "  ", createdAt: 3 },
  ]);
  const reply = blocks.find((block) => block.type === "reply");
  assert.ok(reply && reply.type === "reply");
  assert.equal(
    displayWorkSteps(reply).filter((step) => step.type === "thought").length,
    0,
  );
});

test("nested worker fold starts closed; .open is only the toggle class on the preview", () => {
  const popout = read("src/ui/WorkPopout.tsx");
  const start = popout.indexOf("function SubagentRow");
  const end = popout.indexOf("function isSpawnTool");
  assert.ok(start >= 0 && end > start, "SubagentRow block not found");
  const row = popout.slice(start, end);
  assert.match(row, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(row, /subagent-preview work-step\$\{failed \? " failed" : ""\}\$\{open \? " open" : ""\}/);
  assert.match(row, /<div className="subagent-thread-slot" aria-hidden=\{!open\}>/);
  assert.match(row, /className="turn user chat peer subagent-turn"/);
  assert.doesNotMatch(row, /ThoughtBlock/);
  assert.doesNotMatch(row, /useStartOpen/);
  assert.doesNotMatch(row, /reveal/);
  const pane = read("src/ui/SessionPane.tsx");
  assert.match(pane, /onOpenThread=\{desk\.selectSession\}/);
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

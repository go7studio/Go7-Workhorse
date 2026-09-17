import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  addLineupRow,
  applyChildIdleSync,
  applyLineupTurnBreak,
  emptyLineup,
  formatAwaitAgentsSnapshot,
  LINEUP_FINISHED_NOTICE,
  lineupIsTerminal,
  maybeEnqueueLineupJoin,
  reconcileIdleChildren,
  reconcilePersistedLineups,
} from "../src/lib/lineup";
import { normalizeAgentRun, parentHasRunningChildren, subagentTurns, workerTaskTitle } from "../src/lib/subagents";
import { displayWorkSteps, groupTranscript, workFoldClockLabel, workFoldElapsedMs } from "../src/lib/turns";
import { crewActivityLine, crewHasOpenTools, crewHasWorkAfterFinish, crewTurnInFlight } from "../src/lib/crew-live";
import { crewDoneKind } from "../src/ui/SessionPane";
import { crewDotKind, workerSidebarLabel } from "../src/ui/ChatRow";
import { workerFoldLabel, crewWorkerName } from "../src/ui/WorkPopout";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** One top-level rule. Empty match must fail — adjacent-slice tests can pass on the wrong block. */
function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[0];
}

test("a worker stays live through thinking, not only while a tool is in flight", () => {
  const running = { status: "running" as const, messages: [] };
  assert.equal(crewTurnInFlight(running), true);
  const thinking = {
    status: "idle" as const,
    agentRun: { status: "running" as const, startedAt: 1, isolation: "shared" as const },
    messages: [{ id: "th", role: "assistant" as const, kind: "thought" as const, text: "planning the mesh", createdAt: 1 }],
  };
  assert.equal(crewTurnInFlight(thinking), true);
  assert.equal(crewActivityLine(thinking as never), "Thinking");
  const leftoverThought = {
    status: "idle" as const,
    agentRun: { status: "completed" as const, startedAt: 1, finishedAt: 2, isolation: "shared" as const },
    messages: [{ id: "th", role: "assistant" as const, kind: "thought" as const, text: "planning the mesh", createdAt: 1 }],
  };
  assert.equal(crewTurnInFlight(leftoverThought), false);
  const toolLive = {
    status: "idle" as const,
    agentRun: { status: "running" as const, startedAt: 1, isolation: "shared" as const },
    messages: [{ id: "t", role: "system" as const, kind: "tool" as const, text: "Read File · running", toolStatus: "running", createdAt: 1 }],
  };
  assert.equal(crewTurnInFlight(toolLive), true);
  const afterTool = {
    status: "idle" as const,
    agentRun: { status: "completed" as const, startedAt: 1, finishedAt: 2, isolation: "shared" as const },
    messages: [{ id: "t", role: "system" as const, kind: "tool" as const, text: "Read File · completed", toolStatus: "completed", createdAt: 1 }],
  };
  assert.equal(crewTurnInFlight(afterTool), false);
  const emptyAssistant = {
    status: "idle" as const,
    agentRun: { status: "running" as const, startedAt: 1, isolation: "shared" as const },
    messages: [{ id: "a", role: "assistant" as const, text: "", createdAt: 1 }],
  };
  assert.equal(crewTurnInFlight(emptyAssistant), true);
  const popout = read("src/ui/WorkPopout.tsx");
  assert.match(popout, /crewTurnInFlight\(child\)/);
  assert.match(popout, /tool-name">Thinking/);
  assert.match(popout, /allowThinking: !talking/);
  assert.match(popout, /workFoldClockLabel/);
  assert.match(popout, /foldLive/);
});

test("elapsed clock advancing with completing tools says Working, then Worked after finish", () => {
  const startedAt = 1_000;
  const mid = workFoldElapsedMs({
    live: true,
    startedAt,
    now: startedAt + 465_000,
    activityAt: [startedAt + 450_000],
  });
  const later = workFoldElapsedMs({
    live: true,
    startedAt,
    now: startedAt + 485_000,
    activityAt: [startedAt + 450_000, startedAt + 480_000],
  });
  assert.equal(workFoldClockLabel({ live: true, elapsed: mid }), "Working · 7m 45s");
  assert.equal(workFoldClockLabel({ live: true, elapsed: later }), "Working · 8m 5s");
  const closed = workFoldElapsedMs({
    live: false,
    startedAt,
    now: startedAt + 600_000,
    workedMs: 485_000,
    activityAt: [startedAt + 480_000],
  });
  assert.equal(workFoldClockLabel({ live: false, elapsed: closed }), "Worked 8m 5s");

  const wren = {
    status: "idle" as const,
    agentRun: { status: "completed" as const, startedAt: 1, finishedAt: 2, isolation: "shared" as const },
    messages: [
      { id: "a", role: "assistant" as const, text: "Phone walk completed. Running stress captures…", createdAt: 2 },
      { id: "t1", role: "system" as const, kind: "tool" as const, text: "Shell · completed", toolStatus: "completed", createdAt: 3 },
      { id: "t2", role: "system" as const, kind: "tool" as const, text: "Shell · completed", toolStatus: "completed", createdAt: 4 },
    ],
  };
  assert.equal(crewHasWorkAfterFinish(wren), true);
  assert.equal(crewTurnInFlight(wren), true);
  assert.equal(crewDotKind(wren), "working");
  assert.doesNotMatch(workerSidebarLabel({
    id: "sess_wren",
    projectId: "scratch0",
    parentId: "sess_ci9j08w1i48y",
    provider: "cursor",
    model: "composer-2.5",
    effort: "high",
    title: "Wren · Fix and ship tutorial",
    mode: "always-approve",
    sandbox: "off",
    status: "idle",
    contextUsed: 0,
    messages: wren.messages,
    agentRun: wren.agentRun,
  } as never), /Done/);

  const finished = {
    ...wren,
    messages: [
      { id: "a", role: "assistant" as const, text: "GREET through DONE.", createdAt: 2 },
      { id: "t1", role: "system" as const, kind: "tool" as const, text: "Shell · completed", toolStatus: "completed", createdAt: 2 },
    ],
  };
  assert.equal(crewHasWorkAfterFinish(finished), false);
  assert.equal(crewTurnInFlight(finished), false);
  assert.match(workerSidebarLabel({
    id: "sess_wren",
    projectId: "scratch0",
    parentId: "sess_ci9j08w1i48y",
    provider: "cursor",
    model: "composer-2.5",
    effort: "high",
    title: "Wren · Fix and ship tutorial",
    mode: "always-approve",
    sandbox: "off",
    status: "idle",
    contextUsed: 0,
    messages: finished.messages,
    agentRun: finished.agentRun,
  } as never), /Done/);
});

test("idle session plus running agentRun is Working, and hydrate does not freeze Worked", () => {
  const grok = {
    status: "idle" as const,
    agentRun: { status: "running" as const, startedAt: 1, isolation: "shared" as const },
    messages: [{ id: "th", role: "assistant" as const, kind: "thought" as const, text: "next tap", createdAt: 2 }],
  };
  assert.equal(crewTurnInFlight(grok), true);
  const elapsed = workFoldElapsedMs({ live: true, startedAt: 1, now: 8_001, activityAt: [2] });
  assert.equal(workFoldClockLabel({ live: true, elapsed }), "Working · 8s");
  const liveRun = normalizeAgentRun({ status: "running", startedAt: 1, isolation: "shared" }, { kind: "local" }, true);
  assert.equal(liveRun?.status, "running");
  const hydrated = {
    status: "idle" as const,
    agentRun: liveRun,
    messages: grok.messages,
  };
  assert.equal(crewTurnInFlight(hydrated), true);
  assert.notEqual(workFoldClockLabel({ live: crewTurnInFlight(hydrated), elapsed }), "Worked 8s");
});

test("await-agents must not sit a still-running worker down between tool rounds", () => {
  const folder = "D:\\Godot\\Projects\\demo-game";
  const parent = {
    id: "orch",
    title: "Open Dev Host",
    status: "idle" as const,
    createdAt: 1,
    updatedAt: 1,
    projectId: "p",
    provider: "grok" as const,
    model: "grok-4.6",
    contextUsed: 0,
    messages: [] as never[],
    lineup: addLineupRow(emptyLineup(folder, 1, "ship 0.6.82"), {
      childId: "sess_dexter",
      title: "Dexter · Ship 0.6.82 horses now",
      slice: "Ship 0.6.82 horses now",
      folder,
      vendor: "Grok",
      status: "running",
      startedAt: 1,
    }),
  };
  const dexter = {
    ...parent,
    id: "sess_dexter",
    parentId: "orch",
    hidden: true,
    title: "Dexter · Ship 0.6.82 horses now",
    workerName: "Dexter",
    lineup: undefined,
    status: "idle" as const,
    agentRun: { status: "running" as const, startedAt: 1, isolation: "shared" as const },
    messages: [{ id: "a", role: "assistant" as const, text: "Tag is on Git Hub. Next I’ll run the Windows NSIS build", createdAt: 2 }],
  };
  const reconciled = reconcileIdleChildren([parent, dexter] as never, "orch", 11);
  const child = reconciled.find((item) => item.id === "sess_dexter");
  const orch = reconciled.find((item) => item.id === "orch");
  assert.equal(child?.agentRun?.status, "running");
  assert.equal(orch?.lineup?.rows[0]?.status, "running");
  assert.equal(lineupIsTerminal(orch?.lineup), false);
  assert.equal(crewTurnInFlight(child!), true);
});

function tutorialParent(rowStatus: "running" | "completed" = "running") {
  const folder = "D:\\Godot\\Projects\\Scratch0";
  return {
    id: "sess_ci9j08w1i48y",
    title: "Tutorial runthrough QA",
    status: "idle" as const,
    createdAt: 1,
    updatedAt: 1,
    projectId: "scratch0",
    provider: "grok" as const,
    model: "grok-4.6",
    contextUsed: 0,
    messages: [] as never[],
    lineup: addLineupRow(emptyLineup(folder, 1, "phone walk"), {
      childId: "sess_wren",
      title: "Wren · Fix and ship tutorial",
      slice: "Fix and ship tutorial",
      folder,
      vendor: "Cursor",
      status: rowStatus,
      startedAt: 1,
      ...(rowStatus === "completed" ? { finishedAt: 2, report: "Phone walk completed. Running stress captures…" } : {}),
    }),
  };
}

function composerBurst(patch: {
  status?: "idle" | "running";
  run?: "running" | "completed";
  tools?: "open" | "done" | "none";
  thought?: boolean;
}) {
  const messages = [];
  if (patch.thought) {
    messages.push({ id: "th", role: "assistant" as const, kind: "thought" as const, text: "planning taps", createdAt: 1 });
  }
  if (patch.tools === "open") {
    messages.push({
      id: "t",
      role: "system" as const,
      kind: "tool" as const,
      text: "Shell · running",
      toolStatus: "running",
      createdAt: 2,
    });
  }
  if (patch.tools === "done") {
    messages.push({
      id: "t",
      role: "system" as const,
      kind: "tool" as const,
      text: "Shell · completed",
      toolStatus: "completed",
      createdAt: 2,
    });
  }
  messages.push({
    id: "a",
    role: "assistant" as const,
    text: patch.tools === "open" ? "Phone walk completed. Running stress captures…" : "Phone walk completed.",
    createdAt: 3,
  });
  return {
    ...tutorialParent(),
    id: "sess_wren",
    parentId: "sess_ci9j08w1i48y",
    hidden: true,
    title: "Wren · Fix and ship tutorial",
    workerName: "Wren",
    provider: "cursor" as const,
    model: "composer-2.5",
    lineup: undefined,
    status: patch.status ?? "idle",
    agentRun: {
      status: patch.run ?? "running",
      startedAt: 1,
      isolation: "shared" as const,
      ...(patch.run === "completed" ? { finishedAt: 4 } : {}),
    },
    messages,
  };
}

test("idle session plus running agentRun stays a running row and is not terminal", () => {
  const parent = tutorialParent("running");
  const wren = composerBurst({ status: "idle", run: "running", tools: "none", thought: true });
  const reconciled = reconcileIdleChildren([parent, wren] as never, parent.id, 11);
  const orch = reconciled.find((item) => item.id === parent.id);
  const child = reconciled.find((item) => item.id === "sess_wren");
  assert.equal(child?.agentRun?.status, "running");
  assert.equal(orch?.lineup?.rows[0]?.status, "running");
  assert.equal(lineupIsTerminal(orch?.lineup, reconciled.filter((item) => item.parentId === parent.id)), false);
  assert.equal(parentHasRunningChildren(reconciled as never, parent.id), true);
});

test("Composer tool bursts after a false complete are not lineup Done", () => {
  const parent = tutorialParent("completed");
  const wren = composerBurst({ status: "idle", run: "completed", tools: "open" });
  assert.equal(crewHasOpenTools(wren.messages), true);
  assert.equal(crewTurnInFlight(wren), true);
  assert.equal(crewDotKind(wren), "working");
  assert.doesNotMatch(workerSidebarLabel(wren as never), /Done/);
  const settled = applyChildIdleSync([parent, wren] as never, "sess_wren", "completed", {
    report: "Phone walk completed. Running stress captures…",
    now: 11,
  });
  assert.equal(settled.find((item) => item.id === "sess_wren")?.agentRun?.status, "completed");
  assert.equal(settled.find((item) => item.id === "sess_wren")?.agentRun?.finishedAt, 4);
  assert.equal(
    lineupIsTerminal(
      settled.find((item) => item.id === parent.id)?.lineup,
      settled.filter((item) => item.parentId === parent.id),
    ),
    false,
    "open tools keep the wave live even if the row already says completed",
  );
});

test("parent must not post All workers finished or join while a child is in flight", () => {
  const parent = tutorialParent("completed");
  const wren = composerBurst({ status: "idle", run: "running", tools: "open" });
  const sessions = [parent, wren] as never;
  const joined = maybeEnqueueLineupJoin(sessions, parent.id, 12);
  assert.equal(joined.find((item) => item.id === parent.id)?.lineup?.notifiedAt, undefined);
  assert.equal(
    joined.find((item) => item.id === parent.id)?.messages.some((message) => message.text === LINEUP_FINISHED_NOTICE),
    false,
  );
  const broken = applyLineupTurnBreak(sessions, parent.id, 12);
  assert.equal(
    broken.find((item) => item.id === parent.id)?.messages.some((message) => message.text === LINEUP_FINISHED_NOTICE),
    false,
  );
  assert.equal(maybeEnqueueLineupJoin(broken, parent.id, 13), broken);
  const snapshot = formatAwaitAgentsSnapshot({
    lineup: parent.lineup,
    children: [wren],
    wait: false,
  });
  assert.match(snapshot, /Wren · Fix and ship tutorial/);
  assert.match(JSON.parse(snapshot).running.join(" "), /Wren/);
});

test("Grok between-tools idle is still running, then Done only after completed+idle", () => {
  const parent = tutorialParent("running");
  const grok = {
    ...composerBurst({ status: "idle", run: "running", tools: "none", thought: true }),
    provider: "grok" as const,
    model: "grok-4.6",
  };
  const mid = reconcileIdleChildren([parent, grok] as never, parent.id, 5);
  assert.equal(mid.find((item) => item.id === "sess_wren")?.agentRun?.status, "running");
  assert.equal(lineupIsTerminal(mid.find((item) => item.id === parent.id)?.lineup, [grok]), false);
  const finished = {
    ...grok,
    agentRun: { status: "completed" as const, startedAt: 1, finishedAt: 6, isolation: "shared" as const },
    messages: [
      { id: "a", role: "assistant" as const, text: "GREET through DONE on the new APK.", createdAt: 6 },
    ],
  };
  assert.equal(crewTurnInFlight(finished), false);
  const settled = applyChildIdleSync(mid, "sess_wren", "completed", {
    report: "GREET through DONE on the new APK.",
    now: 6,
  });
  const orch = settled.find((item) => item.id === parent.id);
  assert.equal(orch?.lineup?.rows[0]?.status, "completed");
  assert.equal(lineupIsTerminal(orch?.lineup, settled.filter((item) => item.parentId === parent.id)), true);
  assert.match(workerSidebarLabel(settled.find((item) => item.id === "sess_wren") as never), /Done/);
});

test("hydrate does not sit a live run down", () => {
  const live = normalizeAgentRun(
    { status: "running", startedAt: 1, isolation: "shared" },
    { kind: "local" },
    true,
  );
  assert.equal(live?.status, "running");
  assert.equal(live?.finishedAt, undefined);
  const parent = tutorialParent("running");
  const wren = composerBurst({ status: "idle", run: "running", tools: "open" });
  const healed = reconcilePersistedLineups([parent, wren] as never, 9);
  assert.equal(healed.find((item) => item.id === "sess_wren")?.agentRun?.status, "running");
  assert.equal(healed.find((item) => item.id === parent.id)?.lineup?.rows[0]?.status, "running");
});

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
  assert.equal(
    crewWorkerName({ fromTitle: "Certify Saga candidate", text: "Certify Saga candidate" }, { title: "Barnaby · Certify Saga candidate", workerName: "Barnaby" }),
    "Barnaby",
  );
  assert.equal(crewWorkerName({ text: "Grok" }, null), "Grok");
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
  assert.match(cssBlock(css, ".crew-done-card strong"), /var\(--text\)/);
  assert.match(cssBlock(css, ".work-pop[data-state=\"done\"] > summary"), /var\(--text\)/);
  assert.match(cssBlock(css, ".work-pop[data-state=\"failed\"] > summary"), /var\(--danger\)/);
  assert.match(cssBlock(css, ".work-pop > summary"), /transition:\s*color 180ms/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.work-pop > summary,\s*\n\s*\.work-pop > summary::before[\s\S]*?transition:\s*none/);
  assert.match(pane, /crewNamesFromTitles/);
  assert.match(pane, /crewNames \? <span>\{crewNames\}<\/span>/);
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

test("a stopped turn does not leave the last thought fold open", () => {
  const popout = read("src/ui/WorkPopout.tsx");
  const thought = popout.slice(popout.indexOf("function ThoughtBlock"), popout.indexOf("function workRowKey"));
  assert.match(thought, /useForcedDetailsOpen\(live, true\)/);
  assert.match(popout, /closeWhenReleased && wasForced\.current && !forced && open/);
  assert.doesNotMatch(thought, /el\.open\s*=/);
  assert.doesNotMatch(thought, /reveal/);
  assert.match(popout, /reveal=\{row\.type !== "thought" && tailIndex === packed\.tail\.length - 1\}/);
  assert.match(popout, /runWasStopped\(child\?\.agentRun\?\.status\)/);
  assert.match(popout, /"stopped"/);
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { sidebarKeepsChat } from "../src/lib/chats";
import { nestProjectChats } from "../src/lib/lineup";
import { formatChatSidebar } from "../src/lib/session";
import { DEFAULT_SETTINGS, normalizeRouting } from "../src/lib/settings";
import { shouldAutoRouteSpawn } from "../src/lib/subagents";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// Shapes taken from workhorse-state.json on 2026-08-17: a lineup run from a
// chat with no project. The parent and all seven workers had projectId null;
// every worker was hidden and carried parentId. The transcript listed seven
// subagents and the sidebar showed none.
const user = { id: "m1", role: "user" as const, text: "summon 8 bots", createdAt: 1 };
const parent = { id: "sess_ra5rpko7gm11", projectId: null, parentId: undefined, hidden: undefined, archivedAt: undefined, messages: [user] };
const worker = (id: string) => ({ id, projectId: null, parentId: parent.id, hidden: true, archivedAt: undefined, messages: [user] });

test("a hidden worker of a loose chat is kept, so it can nest under its parent", () => {
  const loose = { projectId: null, archived: false };
  assert.equal(sidebarKeepsChat(parent, loose), true);
  assert.equal(sidebarKeepsChat(worker("sess_msxfioh"), loose), true, "hidden, but it has a parent");
  // A hidden chat with no parent stays hidden — that is what hidden is for.
  assert.equal(sidebarKeepsChat({ ...worker("x"), parentId: undefined }, loose), false);
  // A project's list keeps its own workers by the same rule, and not the loose ones.
  const inProject = { projectId: "proj_jpkn86mexzkt", archived: false };
  assert.equal(sidebarKeepsChat({ ...worker("y"), projectId: "proj_jpkn86mexzkt" }, inProject), true);
  assert.equal(sidebarKeepsChat(worker("z"), inProject), false);
  // Archive line still holds on both sides.
  assert.equal(sidebarKeepsChat({ ...parent, archivedAt: 5 }, loose), false);
  assert.equal(sidebarKeepsChat({ ...parent, archivedAt: 5 }, { projectId: null, archived: true }), true);
  // A draft (no user prompt yet) is not listed anywhere.
  assert.equal(sidebarKeepsChat({ ...parent, messages: [] }, loose), false);
});

test("the loose list nests the seven workers under the chat that spawned them", () => {
  const sessions = [parent, ...["a", "b", "c", "d", "e", "f", "g"].map((s) => worker(`sess_${s}`))];
  const listed = sessions.filter((session) => sidebarKeepsChat(session, { projectId: null, archived: false }));
  const nested = nestProjectChats(listed);
  assert.equal(nested.length, 1, "one row: the parent");
  assert.equal(nested[0]!.id, parent.id);
  assert.equal(nested[0]!.workers.length, 7, "seven workers under it");
});

test("both sidebar lists share the one rule", () => {
  const store = read("src/lib/store.tsx");
  const project = store.slice(store.indexOf("export function useProjectSessions"), store.indexOf("export function useLooseSessions"));
  const loose = store.slice(store.indexOf("export function useLooseSessions"));
  assert.match(project, /sidebarKeepsChat\(session, \{ projectId, archived \}\)/);
  assert.match(loose.slice(0, 400), /sidebarKeepsChat\(session, \{ projectId: null, archived \}\)/);
  // No second copy of the rule to drift again.
  assert.doesNotMatch(project, /isHiddenSession/);
  assert.doesNotMatch(loose.slice(0, 400), /isHiddenSession/);
});

test("an auto-routed chat says Auto where a model name would read as the plan", () => {
  // The row under the chat title.
  assert.equal(
    formatChatSidebar({ provider: "cursor", model: "composer-2.5", effort: "high", mode: "always-approve", routingMode: "auto" }),
    "Auto · Always approve",
  );
  assert.equal(
    formatChatSidebar({ provider: "cursor", model: "composer-2.5", effort: "high", mode: "always-approve", routingMode: "manual" }),
    "Composer 2.5 · High · Always approve",
  );
  assert.equal(
    formatChatSidebar({ provider: "grok", model: "grok-4.6", effort: "medium", mode: "ask" }),
    "Grok 4.6 · Medium · Ask",
    "no routingMode at all reads as before",
  );
  // The row passes the mode through, and the composer chip — Composer's
  // setup-trigger, the one that actually renders — says Auto too. (An older
  // ModelMenu carried its own Auto label but nothing mounted it; live testing
  // found that, and it has since been removed. See test/dead-ui.test.ts.)
  assert.match(read("src/ui/ChatRow.tsx"), /routingMode: session\.routingMode/);
  const composer = read("src/ui/Composer.tsx");
  const chip = composer.slice(composer.indexOf('className={`setup-trigger'), composer.indexOf('className={`setup-trigger') + 1400);
  assert.match(chip, /session\.routingMode === "auto"\s*\?\s*`Auto · \$\{shortModeLabel\(session\.mode\)\}`/);
  assert.match(chip, /className="dot auto"/);
});

test("a routed pick does not become the default for the next new chat", () => {
  // Routing rewrote lastModel with its pick, so one turn routed to Kimi
  // seeded every chat opened after it with Kimi. Only a user's choice
  // (setSessionModel, newChat) may write lastModel.
  const store = read("src/lib/store.tsx");
  const routed = store.slice(store.indexOf("const decision = chooseRoutingDecision("), store.indexOf("const decision = chooseRoutingDecision(") + 2400);
  assert.match(routed, /routingMode: "auto", routingDecision: decision/);
  assert.doesNotMatch(routed, /lastModel: presetFrom\(routedSession\)/);
});

// ---------------------------------------------------------------------------
// Who routes, and when. Two actors, two switches.
//
//   A person's chat keeps the model they picked. Only a chat set to Auto hands
//   model and effort to routing, and it does so on every message. Auto is a
//   pick made on the chat. New chats are manual; no setting puts a chat on
//   Auto for anyone.
//
//   The desk routes the work it hands out: when a chat spawns a worker without
//   naming a bot, the desk picks the bot and effort for the slice. That is
//   Settings → Routing — on unless the person turns it off. A named bot wins.
// ---------------------------------------------------------------------------

test("a person's chat routes only when that chat is set to Auto", () => {
  const store = read("src/lib/store.tsx");
  const send = store.slice(store.indexOf("let session = current.sessions.find((item) => item.id === targetSessionId)"));
  const gate = send.slice(0, send.indexOf("chooseRoutingDecision("));
  assert.match(gate, /shouldRouteSessionTurn\(\{ routingMode: session\.routingMode/, "the chat's own mode is the gate");
  assert.doesNotMatch(gate, /settings\.routing\.enabled/, "the Settings switch does not reach into a person's chat");
  // Auto picks the effort with the model.
  const routed = send.slice(send.indexOf("if (decision) {"), send.indexOf("if (decision) {") + 600);
  assert.match(routed, /effort: decision\.effort/);
});

test("a new chat is manual; no setting puts it on Auto", () => {
  const store = read("src/lib/store.tsx");
  const create = store.slice(store.indexOf('title: "New chat"'), store.indexOf('title: "New chat"') + 900);
  assert.match(create, /routingMode: "manual"/);
  assert.doesNotMatch(create, /routing\.enabled \? "auto"/);
});

test("Auto is a pick a person makes on the chat, not in Settings", () => {
  const setup = read("src/ui/SessionSetup.tsx");
  assert.match(setup, /onClick=\{\(\) => setSessionRoutingMode\("auto"\)\}/);
  assert.doesNotMatch(setup, /settings\.routing\.enabled \? setSessionRoutingMode/, "Auto no longer bounces to Settings");
  // In Auto the effort is picked per message, so the reasoning slider in the
  // setup panel steps aside and says so.
  assert.match(setup, /session\.routingMode === "auto" && \(\s*<section className="setup-card setup-reasoning-card">/);
  assert.match(setup, /Picked with the model for each message/);
  assert.match(setup, /session\.routingMode !== "auto" && thinking\.length > 0 && \(/);
});

test("Settings → Routing is the desk's own routing for spawned work: on by default, off is a choice", () => {
  assert.equal(DEFAULT_SETTINGS.routing.enabled, true, "the desk routes the work it hands out unless told not to");
  // A stored false is the person turning it off; anything else is on.
  assert.equal(normalizeRouting({}).enabled, true);
  assert.equal(normalizeRouting({ enabled: false }).enabled, false);
  assert.equal(normalizeRouting({ enabled: true }).enabled, true);
  // The store reads the switch at the desk-model gate and the separately
  // granted harness gate. Both are spawn paths; neither touches user chats.
  const store = read("src/lib/store.tsx");
  assert.equal(store.split("settings.routing.enabled").length - 1, 1);
  assert.match(store, /decideDispatch\(/);
  const spawn = store.slice(store.indexOf("const routeSpawn = shouldAutoRouteSpawn({"), store.indexOf("const routeSpawn = shouldAutoRouteSpawn({") + 320);
  assert.match(spawn, /routingEnabled: latest\.settings\.routing\.enabled/);
  // The Settings pane names what it governs.
  const pane = read("src/ui/RoutingPane.tsx");
  assert.match(pane, /Route the work the desk hands out/);
  assert.match(pane, /Auto-pick a bot and effort for delegated work/);
});

test("the desk routes a spawn unless the orchestrator names a bot, and picks effort for the slice", () => {
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true }), true);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, provider: "custom" }), false, "a named provider wins");
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, model: "MiniMax-M3" }), false, "a named model wins");
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, chat: "Kimi" }), false, "a named chat wins");
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: false }), false, "off: the worker takes its parent's bot");
  const store = read("src/lib/store.tsx");
  assert.match(store, /effort: effortForRoutingTier\(\s*resolvedSpec\.provider,\s*resolvedSpec\.model,\s*selectedTier,\s*requestedEffort \?\? routeDecision\?\.effort,?\s*\)/);
});

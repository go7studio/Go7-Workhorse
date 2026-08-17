import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { sidebarKeepsChat } from "../src/lib/chats";
import { nestProjectChats } from "../src/lib/lineup";
import { formatChatSidebar } from "../src/lib/session";

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
  // The row passes the mode through, and the composer chip says Auto too.
  assert.match(read("src/ui/ChatRow.tsx"), /routingMode: session\.routingMode/);
  const menu = read("src/ui/ModelMenu.tsx");
  assert.match(menu, /session\.routingMode === "auto"\s*\?\s*"Auto"/);
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

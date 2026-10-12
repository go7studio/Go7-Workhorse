import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendTeamEvents, readTeamJournal, readTeamPresence, writeTeamPresence } from "../electron/team-journal";
import { applyPermissionAnswer } from "../src/lib/permissions";
import {
  canStopHere,
  ceilingEvent,
  combineJournals,
  foldTeamJournal,
  inboxOwnerEvent,
  joinTeam,
  parseTeamLocator,
  permissionAnsweredEvent,
  PRESENCE_TTL_MS,
  resolveWorkshopGrant,
  sanitizeTeamEvent,
  startTeam,
  syncTeamProject,
  teamCeilingStop,
  teamProjectTotal,
  whoIsInChat,
  workshopGrantEvent,
  workshopGrantFor,
  type TeamLocal,
} from "../src/lib/team";
import type { LocalComputeHostSettings, PermissionRequest, Project, Session, UsageEvent } from "../src/lib/types";
import type { WorkshopSettings } from "../src/lib/workshop-pack";

/*
 * Two desks, one journal. Ana's desk is a Windows desk with everything turned
 * up; Ben's is a macOS-style desk with everything locked down. Neither desk's
 * secrets, settings, or paths may reach the other, and every test reads the
 * journal's bytes on disk to prove it. Paths here are strings only: no test
 * reads either person's machine.
 */

const PROJECT = "proj_shared";
const ANA_FOLDER = "C:\\Users\\ana\\work\\atlas";
const BEN_FOLDER = "/Users/ben/code/atlas";
const ANA_KEY = "sk-ana-SECRET-0f9e8d7c6b5a";
const ANA_TOKEN_FILE = "C:\\Users\\ana\\.workhorse\\gpu-token.txt";
const ANA_HOST_URL = "http://10.20.30.40:9100";
const ANA_VENDOR_SESSION = "vendor-sess-ana-77aa";
const ANA_BOOKMARK = "bookmark-ana-BASE64==";
const ANA_BYTES = "iVBORw0KGgoANAPIXELBYTES";

type Who = Omit<TeamLocal, "now">;
const ANA: Who = { device: "dev_ana", seat: "ana", mode: "always-approve", sandbox: "off" };
const BEN: Who = { device: "dev_ben", seat: "ben", mode: "ask", sandbox: "strict" };

type Desk = {
  projects: Project[];
  sessions: Session[];
  pending: PermissionRequest[];
  usage: UsageEvent[];
  settings: {
    customBots: Array<{ id: string; apiKey: string }>;
    workshop: WorkshopSettings;
    localCompute: { hosts: LocalComputeHostSettings[] };
    watch: { dailyLimitPercent: number };
    usageBudgets: Record<string, number>;
  };
  deskPlans: { claude: { leftPercent: number; usedPercent: number } };
};

function chat(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    projectId: PROJECT,
    provider: "claude",
    model: "claude-opus-4-7",
    effort: null,
    title: "Atlas plan",
    mode: "always-approve",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
    archivedAt: null,
    ...over,
  } as Session;
}

function host(id: string, label: string, tokenFile: string, baseUrl: string): LocalComputeHostSettings {
  return { id, label, baseUrl, tokenFile, enabled: true, allowedCallerRoles: [], allowedCapabilities: [], allowedContinuations: [] };
}

function anaDesk(): Desk {
  return {
    projects: [
      {
        id: PROJECT,
        name: "Atlas",
        createdAt: 1,
        openedAt: 1,
        folders: [{ id: "fold_a", path: ANA_FOLDER, label: "atlas", bookmark: ANA_BOOKMARK }],
        references: [],
      },
    ],
    sessions: [],
    pending: [],
    usage: [],
    settings: {
      customBots: [{ id: "bot_a", apiKey: ANA_KEY }],
      workshop: { packs: [{ id: "spark-media", on: true, hostId: "host_a", sources: ["feed", "probes"] }] },
      localCompute: { hosts: [host("host_a", "Studio GPU", ANA_TOKEN_FILE, ANA_HOST_URL)] },
      watch: { dailyLimitPercent: 61 },
      usageBudgets: { claude: 424242 },
    },
    deskPlans: { claude: { leftPercent: 37.25, usedPercent: 62.75 } },
  };
}

function benDesk(): Desk {
  return {
    projects: [],
    sessions: [],
    pending: [],
    usage: [],
    settings: {
      customBots: [],
      workshop: { packs: [] },
      localCompute: { hosts: [] },
      watch: { dailyLimitPercent: 90 },
      usageBudgets: {},
    },
    deskPlans: { claude: { leftPercent: 88, usedPercent: 12 } },
  };
}

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-team-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function journalOf(desk: Desk): string {
  return desk.projects.find((item) => item.id === PROJECT)!.team!.journalId;
}

/** One desk reads the journal in its own folder, publishes, and takes. */
function pass(desk: Desk, who: Who, now: number, dir?: string) {
  const link = desk.projects.find((item) => item.id === PROJECT)!.team!;
  const folder = dir ?? link.folder;
  const events = readTeamJournal(folder, link.journalId);
  const result = syncTeamProject(desk, PROJECT, events, { ...who, now })!;
  appendTeamEvents(folder, link.journalId, who.device, result.append);
  desk.sessions = result.sessions;
  desk.projects = desk.projects.map((item) =>
    item.id === PROJECT ? { ...item, team: { ...item.team!, baseline: result.baseline } } : item,
  );
  return result;
}

function shareAndJoin(root: string, ana = anaDesk(), ben = benDesk()) {
  const started = startTeam({ project: ana.projects[0], folder: root, local: { ...ANA, now: 1_000 } });
  assert.ok(!("error" in started));
  appendTeamEvents(root, started.link.journalId, ANA.device, started.events);
  ana.projects[0] = { ...ana.projects[0], team: started.link };
  const joined = joinTeam({ locator: started.locator, folder: root, local: { ...BEN, now: 2_000 }, projects: ben.projects });
  assert.ok(!("error" in joined));
  appendTeamEvents(root, started.link.journalId, BEN.device, joined.events);
  ben.projects.push(joined.project);
  return { ana, ben, locator: started.locator, journalId: started.link.journalId };
}

/** Every byte both desks wrote into the shared folder, journal and presence. */
function journalBytes(root: string): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return out.join("\n");
}

/** The test that must fail if a key, a sandbox, a permission mode, or a folder path crosses. */
function assertNothingPrivateCrossed(bytes: string) {
  const forbidden: Array<[string, string]> = [
    [ANA_KEY, "an API key"],
    ["apiKey", "a key field"],
    [ANA_TOKEN_FILE, "a Workshop token file"],
    [ANA_TOKEN_FILE.replace(/\\/g, "\\\\"), "a Workshop token file (JSON-escaped)"],
    ["tokenFile", "a token file field"],
    [ANA_HOST_URL, "a host URL"],
    [ANA_FOLDER, "a folder path"],
    [ANA_FOLDER.replace(/\\/g, "\\\\"), "a folder path (JSON-escaped)"],
    [BEN_FOLDER, "a folder path"],
    [ANA_BOOKMARK, "a folder bookmark"],
    ['"sandbox"', "a sandbox field"],
    ['"strict"', "a sandbox value"],
    ['"mode"', "a permission mode field"],
    ["always-approve", "a permission mode value"],
    ["permissionGrants", "a permission grant"],
    ["vendorSessionId", "a vendor session field"],
    [ANA_VENDOR_SESSION, "a vendor session id"],
    [ANA_BYTES, "attachment bytes"],
    ["leftPercent", "a leftover ring"],
    ["37.25", "a leftover percent"],
    ["dailyLimitPercent", "a limit setting"],
    ["424242", "a usage budget"],
  ];
  for (const [needle, what] of forbidden) {
    assert.ok(!bytes.includes(needle), `${what} crossed the journal: found ${JSON.stringify(needle)}`);
  }
}

test("a pasted locator joins the second desk and copies no key, leftover, Permission, Sandbox, or folder", (t) => {
  const root = tempRoot(t);
  const { ana, ben, locator } = shareAndJoin(root);
  ana.sessions.push(
    chat("sess_a1", {
      vendorSessionId: ANA_VENDOR_SESSION,
      folders: [{ id: "fold_s", path: ANA_FOLDER, label: "atlas" }],
      permissionGrants: [{ id: "grant_a", key: `write:${ANA_FOLDER}`, tool: "Write", detail: ANA_FOLDER, createdAt: 1, expiresAt: 9e15 }],
      messages: [{ id: "m1", role: "user", text: "Start the atlas", createdAt: 3_000 }],
    }),
  );
  pass(ana, ANA, 3_100);
  pass(ben, BEN, 3_200);

  const decoded = Buffer.from(locator.slice("go7-team:".length), "base64url").toString("utf8");
  assertNothingPrivateCrossed(decoded);
  assert.equal(parseTeamLocator(locator)?.from, "ana");

  const joined = ben.projects[0];
  assert.deepEqual(joined.folders, [], "a joining desk links its own folders");
  const arrived = ben.sessions.find((item) => item.id === "sess_a1")!;
  assert.equal(arrived.mode, "ask", "Ben's own Permission default, not Ana's");
  assert.equal(arrived.sandbox, "strict", "Ben's own Sandbox default, not Ana's");
  assert.equal(arrived.vendorSessionId, undefined, "Ben's vendor session is his own");
  assert.equal(arrived.permissionGrants, undefined);
  assert.equal(arrived.folders, undefined);
  assert.deepEqual(ben.settings.customBots, [], "no key arrives");
  assert.equal(ben.deskPlans.claude.leftPercent, 88, "Ben's leftover ring is his own");
  assert.equal(ana.sessions[0].mode, "always-approve", "Ana keeps hers");

  assertNothingPrivateCrossed(journalBytes(root));
});

test("the journal's door drops a planted key, sandbox, mode, or path, on write and on read", (t) => {
  const root = tempRoot(t);
  const { journalId } = shareAndJoin(root);
  const planted = {
    id: "tev_planted",
    at: 9_000,
    journal: journalId,
    device: BEN.device,
    seat: "ben",
    type: "chat.titled",
    chatId: "sess_x",
    title: "ok",
    apiKey: ANA_KEY,
    sandbox: "strict",
    mode: "always-approve",
    folders: [{ path: BEN_FOLDER }],
  };
  const clean = sanitizeTeamEvent(planted);
  assert.ok(clean);
  assertNothingPrivateCrossed(JSON.stringify(clean));
  appendTeamEvents(root, journalId, BEN.device, [planted]);
  assertNothingPrivateCrossed(journalBytes(root));

  // Something outside Workhorse writes straight into the file; the reader still drops it.
  const file = path.join(root, journalId, "journal", `${BEN.device}.jsonl`);
  writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ ...planted, id: "tev_raw" })}\n`, "utf8");
  assertNothingPrivateCrossed(JSON.stringify(readTeamJournal(root, journalId)));
  // And a desk cannot speak for another desk from its own file.
  writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ ...planted, id: "tev_forged", device: ANA.device })}\n`, "utf8");
  assert.ok(!readTeamJournal(root, journalId).some((item) => item.id === "tev_forged"));
});

test("chats, archive state, and transcripts travel; attachment bytes and folder links stay put", (t) => {
  const root = tempRoot(t);
  const { ana, ben } = shareAndJoin(root);
  ben.projects[0] = { ...ben.projects[0], folders: [{ id: "fold_b", path: BEN_FOLDER, label: "atlas" }] };
  ana.sessions.push(
    chat("sess_a1", {
      messages: [
        {
          id: "m1",
          role: "user",
          text: "Look at this",
          createdAt: 3_000,
          images: [{ id: "img1", name: "shot.png", mimeType: "image/png", data: ANA_BYTES, kind: "image", sourcePath: `${ANA_FOLDER}\\shot.png` }],
        },
        { id: "m2", role: "assistant", text: `I edited ${ANA_FOLDER}\\src\\app.ts`, createdAt: 3_001, provider: "claude", model: "claude-opus-4-7" },
      ],
    }),
  );
  pass(ana, ANA, 3_100);
  pass(ben, BEN, 3_200);

  const copy = ben.sessions.find((item) => item.id === "sess_a1")!;
  assert.equal(copy.title, "Atlas plan");
  assert.equal(copy.messages.length, 2);
  assert.equal(copy.messages[0].images, undefined, "bytes stay on Ana's desk");
  assert.deepEqual(copy.messages[0].teamAttachments?.map((item) => [item.name, item.on]), [["shot.png", "ana"]]);
  assert.equal(copy.messages[1].text, `I edited ${BEN_FOLDER}\\src\\app.ts`, "the path names Ben's own folder");
  assert.equal(copy.team?.device, ANA.device);

  // Ben archives and renames; Ana sees both. A second pass on either side writes nothing new.
  ben.sessions = ben.sessions.map((item) => (item.id === "sess_a1" ? { ...item, title: "Atlas v2", archivedAt: 4_000 } : item));
  pass(ben, BEN, 4_100);
  pass(ana, ANA, 4_200);
  const mine = ana.sessions.find((item) => item.id === "sess_a1")!;
  assert.equal(mine.title, "Atlas v2");
  assert.equal(mine.archivedAt, 4_000);
  assert.equal(mine.messages[0].images?.[0].data, ANA_BYTES, "Ana still has her own bytes");
  assert.equal(pass(ana, ANA, 4_300).append.length, 0);
  assert.equal(pass(ben, BEN, 4_400).append.length, 0);

  // Unarchive on Ana's side travels back too.
  ana.sessions = ana.sessions.map((item) => (item.id === "sess_a1" ? { ...item, archivedAt: null } : item));
  pass(ana, ANA, 4_500);
  pass(ben, BEN, 4_600);
  assert.equal(ben.sessions.find((item) => item.id === "sess_a1")!.archivedAt, null);

  assertNothingPrivateCrossed(journalBytes(root));
});

test("a prompt and a permission answer carry the seat; a 24-hour grant and a limit stay on their own desk", (t) => {
  const root = tempRoot(t);
  const { ana, ben } = shareAndJoin(root);
  ana.sessions.push(chat("sess_a1", { messages: [{ id: "m1", role: "user", text: "go", createdAt: 3_000 }] }));
  pass(ana, ANA, 3_100);
  pass(ben, BEN, 3_200);

  // Ben types into the chat Ana started.
  ben.sessions = ben.sessions.map((item) =>
    item.id === "sess_a1" ? { ...item, messages: [...item.messages, { id: "m_ben", role: "user" as const, text: "also the map", createdAt: 3_300 }] } : item,
  );
  pass(ben, BEN, 3_400);
  pass(ana, ANA, 3_500);
  const onAna = ana.sessions.find((item) => item.id === "sess_a1")!;
  assert.equal(onAna.messages.find((item) => item.id === "m1")?.seat, "ana");
  assert.equal(onAna.messages.find((item) => item.id === "m_ben")?.seat, "ben");

  // Ana's turn asks; Ana answers "for this chat" (the 24-hour grant).
  const card: PermissionRequest = { id: "perm_1", sessionId: "sess_a1", provider: "claude", tool: "Write", detail: `${ANA_FOLDER}\\notes.md` };
  ana.pending = [card];
  pass(ana, ANA, 3_600);
  pass(ben, BEN, 3_650);
  const waiting = foldTeamJournal(readTeamJournal(root, journalOf(ben))).waiting;
  assert.deepEqual(waiting.map((item) => [item.requestId, item.seat]), [["perm_1", "ana"]]);

  const answered = applyPermissionAnswer(ana, "perm_1", "session")!;
  ana.pending = answered.pending;
  ana.sessions = answered.sessions;
  assert.equal(ana.sessions.find((item) => item.id === "sess_a1")!.permissionGrants?.length, 1, "Ana's desk holds the grant");
  appendTeamEvents(root, journalOf(ana), ANA.device, [permissionAnsweredEvent(journalOf(ana), card, "session", { ...ANA, now: 3_700 })]);

  // A desk that is not running the turn cannot close its card.
  appendTeamEvents(root, journalOf(ben), BEN.device, [permissionAnsweredEvent(journalOf(ben), { id: "perm_ghost", sessionId: "sess_a1" }, "once", { ...BEN, now: 3_710 })]);

  // Ana lowers her own limits. Nothing about it is an event.
  ana.settings.watch.dailyLimitPercent = 12;
  ana.settings.usageBudgets.claude = 424242;
  pass(ana, ANA, 3_800);
  pass(ben, BEN, 3_900);

  const view = foldTeamJournal(readTeamJournal(root, journalOf(ben)));
  assert.deepEqual(view.waiting, []);
  assert.deepEqual(view.answers.map((item) => [item.requestId, item.answer, item.seat]), [["perm_1", "session", "ana"]]);
  assert.equal(ben.sessions.find((item) => item.id === "sess_a1")!.permissionGrants, undefined, "the grant did not travel");
  assert.equal(ben.settings.watch.dailyLimitPercent, 90, "Ben's limit is his own");
  assertNothingPrivateCrossed(journalBytes(root));
});

test("presence is live and never replayed; a worker can only be stopped on the desk that started it", (t) => {
  const root = tempRoot(t);
  const { ana, ben, journalId } = shareAndJoin(root);
  ana.sessions.push(chat("sess_a1"));
  ana.sessions.push(
    chat("sess_worker", {
      parentId: "sess_a1",
      hidden: true,
      workerName: "Wren",
      title: "Wren · map slice",
      status: "running",
      agentRun: { status: "running", startedAt: 3_000 } as Session["agentRun"],
      messages: [{ id: "w1", role: "user", text: "slice", createdAt: 3_000 }],
    }),
  );
  pass(ana, ANA, 3_100);
  pass(ben, BEN, 3_200);

  writeTeamPresence(root, journalId, { device: ANA.device, seat: "ana", chatId: "sess_a1", at: 10_000 });
  writeTeamPresence(root, journalId, { device: BEN.device, seat: "ben", chatId: "sess_a1", at: 10_000 });
  const beats = readTeamPresence(root, journalId);
  assert.deepEqual(whoIsInChat(beats, "sess_a1", 10_500), ["ana", "ben"]);
  assert.deepEqual(whoIsInChat(beats, "sess_a1", 10_000 + PRESENCE_TTL_MS + 1), [], "a disconnect is not replayed");
  const replay = foldTeamJournal(readTeamJournal(root, journalId));
  assert.ok(!JSON.stringify([...replay.chats.values()]).includes('"chatId"'), "presence is not a journal event");

  const workerOnBen = ben.sessions.find((item) => item.id === "sess_worker")!;
  assert.equal(workerOnBen.hidden, true, "copied as a work record");
  assert.equal(workerOnBen.parentId, "sess_a1");
  assert.equal(workerOnBen.status, "idle", "Ben's desk is not running it");
  assert.equal(workerOnBen.team?.runningOn, ANA.device);
  assert.equal(canStopHere(workerOnBen, BEN.device), false);
  assert.equal(canStopHere(ana.sessions.find((item) => item.id === "sess_worker")!, ANA.device), true);

  assert.deepEqual(replay.members, ["ana", "ben"], "workers are not people");
  const toWorker = inboxOwnerEvent({ view: replay, to: "Wren", how: "handoff", local: { ...ANA, now: 11_000 } });
  assert.ok("error" in toWorker, "a worker cannot own the inbox");

  // The worker finishes on Ana's desk; Ben sees it stop running.
  ana.sessions = ana.sessions.map((item) =>
    item.id === "sess_worker" ? { ...item, status: "idle" as const, agentRun: { ...item.agentRun!, status: "completed" as const } } : item,
  );
  pass(ana, ANA, 12_000);
  pass(ben, BEN, 12_100);
  assert.equal(ben.sessions.find((item) => item.id === "sess_worker")!.team?.runningOn, undefined);
});

test("project usage sums across seats, is partial while a desk is off, and the ceiling stops only the next send", (t) => {
  const root = tempRoot(t);
  const { ana, ben, journalId } = shareAndJoin(root);
  const row = (id: string, costUsd: number, at: number): UsageEvent => ({
    id,
    at,
    provider: "claude",
    model: "claude-opus-4-7",
    projectId: PROJECT,
    sessionId: "sess_a1",
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  });
  ana.sessions.push(chat("sess_a1", { messages: [{ id: "m1", role: "user", text: "go", createdAt: 3_000 }] }));
  ana.usage.push(row("use_a1", 3, 3_000));
  ana.usage.push({ ...row("use_other", 50, 3_000), projectId: "proj_private" });
  pass(ana, ANA, 3_100);
  pass(ben, BEN, 3_200);
  ben.usage.push(row("use_b1", 4, 3_300));
  pass(ben, BEN, 3_400);
  pass(ana, ANA, 3_500);

  const view = foldTeamJournal(readTeamJournal(root, journalId));
  const bothOn = [
    { device: ANA.device, seat: "ana", chatId: null, at: 20_000 },
    { device: BEN.device, seat: "ben", chatId: null, at: 20_000 },
  ];
  const total = teamProjectTotal({ view, beats: bothOn, now: 20_100, device: ANA.device, seat: "ana", projectId: PROJECT, localUsage: ana.usage });
  assert.equal(total.costUsd, 7, "Ana's $3 and Ben's $4; Ana's other project is not here");
  assert.equal(total.tokens, 3_000);
  assert.deepEqual(total.bySeat.map((item) => [item.seat, item.costUsd]), [["ana", 3], ["ben", 4]]);
  assert.equal(total.partial, false);

  const benOff = teamProjectTotal({ view, beats: bothOn.slice(0, 1), now: 20_100, device: ANA.device, seat: "ana", projectId: PROJECT });
  assert.equal(benOff.partial, true, "Ben's desk is shut, so the total is marked partial");
  assert.deepEqual(benOff.offline, ["ben"]);

  // A shared ceiling is its own event.
  appendTeamEvents(root, journalId, BEN.device, [ceilingEvent(view, { usd: 5 }, { ...BEN, now: 21_000 })]);
  const capped = foldTeamJournal(readTeamJournal(root, journalId));
  assert.deepEqual(capped.ceiling, { usd: 5 });
  assert.match(teamCeilingStop(total, capped.ceiling) ?? "", /over its shared ceiling/);
  assert.equal(teamCeilingStop({ tokens: 0, costUsd: 4.99 }, capped.ceiling), null);

  // A send already in progress on Ana's desk finishes: nothing the journal brings stops or rewrites it.
  ana.sessions = ana.sessions.map((item) =>
    item.id === "sess_a1"
      ? {
          ...item,
          status: "running" as const,
          messages: [...item.messages, { id: "m2", role: "user" as const, text: "one more", createdAt: 21_100 }, { id: "m3", role: "assistant" as const, text: "half an ans", createdAt: 21_200 }],
        }
      : item,
  );
  pass(ana, ANA, 21_300);
  const running = ana.sessions.find((item) => item.id === "sess_a1")!;
  assert.equal(running.status, "running");
  assert.equal(running.messages.at(-1)?.text, "half an ans");
  assert.ok(!journalBytes(root).includes("half an ans"), "an in-flight answer is not published");
  assertNothingPrivateCrossed(journalBytes(root));
});

test("one Workshop grant names pack, sources, and host label; each desk resolves its own host or says it has none", (t) => {
  const root = tempRoot(t);
  const { ana, ben, journalId } = shareAndJoin(root);
  const grant = workshopGrantFor(ana.settings.workshop, ana.settings.localCompute.hosts, "spark-media");
  assert.deepEqual(grant, { pack: "spark-media", sources: ["feed", "probes"], host: "Studio GPU" });
  const view = foldTeamJournal(readTeamJournal(root, journalId));
  appendTeamEvents(root, journalId, ANA.device, [workshopGrantEvent(view, grant!, { ...ANA, now: 5_000 })]);
  pass(ben, BEN, 5_100);

  const shared = foldTeamJournal(readTeamJournal(root, journalId)).grants.get("spark-media")!;
  assert.deepEqual([shared.pack, shared.sources, shared.host, shared.seat], ["spark-media", ["feed", "probes"], "Studio GPU", "ana"]);

  const before = JSON.stringify(ben.settings.workshop);
  assert.deepEqual(resolveWorkshopGrant(shared, ben.settings.localCompute.hosts), {
    status: "no-host",
    message: "No host named Studio GPU on this desk.",
  });
  assert.equal(JSON.stringify(ben.settings.workshop), before, "Ben's desk did not get Ana's cards");

  ben.settings.localCompute.hosts.push(host("host_b", "studio gpu", "/Users/ben/.workhorse/token", "http://127.0.0.1:9100"));
  assert.deepEqual(resolveWorkshopGrant(shared, ben.settings.localCompute.hosts), { status: "ready", hostId: "host_b" });
  assertNothingPrivateCrossed(journalBytes(root));
});

test("the inbox starts with whoever sent the locator, moves by name, and taking it allows nothing", (t) => {
  const root = tempRoot(t);
  const { ana, ben, journalId } = shareAndJoin(root);
  const read = () => foldTeamJournal(readTeamJournal(root, journalId));
  assert.equal(read().inbox.owner, "ana", "the sender of the locator");

  const toBen = inboxOwnerEvent({ view: read(), to: "@ben", how: "handoff", local: { ...ANA, now: 3_000 } });
  assert.ok("event" in toBen);
  appendTeamEvents(root, journalId, ANA.device, [toBen.event]);
  assert.equal(read().inbox.owner, "ben");

  // Ben's desk shuts. Ana's turn asks for a tool; the card waits on Ana's desk.
  ana.sessions.push(chat("sess_a1", { messages: [{ id: "m1", role: "user", text: "go", createdAt: 3_100 }] }));
  ana.pending = [{ id: "perm_wait", sessionId: "sess_a1", provider: "claude", tool: "Bash", detail: "npm test" }];
  pass(ana, ANA, 3_200);
  const take = inboxOwnerEvent({ view: read(), to: "", how: "take", local: { ...ANA, now: 3_300 } });
  assert.ok("event" in take);
  appendTeamEvents(root, journalId, ANA.device, [take.event]);
  pass(ana, ANA, 3_400);

  const after = read();
  assert.equal(after.inbox.owner, "ana");
  assert.equal(after.inbox.how, "take");
  assert.deepEqual(after.waiting.map((item) => item.requestId), ["perm_wait"], "the card still waits");
  assert.deepEqual(after.answers, [], "taking the inbox is not an Allow");
  assert.equal(ana.pending.length, 1);
  assert.equal(ana.sessions.find((item) => item.id === "sess_a1")!.permissionGrants, undefined);

  // Ben comes back and hands it straight back by name.
  pass(ben, BEN, 3_500);
  const back = inboxOwnerEvent({ view: read(), to: "ben", how: "handoff", local: { ...BEN, now: 3_600 } });
  assert.ok("event" in back);
  appendTeamEvents(root, journalId, BEN.device, [back.event]);
  assert.equal(read().inbox.owner, "ben");
});

test("two desks apart keep appending; when they meet, events combine by id and a running turn is not cut off", (t) => {
  const root = tempRoot(t);
  const { ana, ben, journalId } = shareAndJoin(root);
  ana.sessions.push(chat("sess_a1", { messages: [{ id: "m1", role: "user", text: "go", createdAt: 3_000 }] }));
  pass(ana, ANA, 3_100);
  pass(ben, BEN, 3_200);

  // They go apart: each computer has its own copy of the shared folder.
  const anaCopy = path.join(root, "..", `${path.basename(root)}-ana`);
  const benCopy = path.join(root, "..", `${path.basename(root)}-ben`);
  t.after(() => {
    rmSync(anaCopy, { recursive: true, force: true });
    rmSync(benCopy, { recursive: true, force: true });
  });
  cpSync(root, anaCopy, { recursive: true });
  cpSync(root, benCopy, { recursive: true });

  // Ben's turn is running on his desk with half an answer on screen.
  ben.sessions = ben.sessions.map((item) =>
    item.id === "sess_a1"
      ? {
          ...item,
          status: "running" as const,
          messages: [...item.messages, { id: "b1", role: "user" as const, text: "ben asks", createdAt: 4_000 }, { id: "b2", role: "assistant" as const, text: "streaming…", createdAt: 4_001 }],
        }
      : item,
  );
  pass(ben, BEN, 4_100, benCopy);
  // Meanwhile Ana, offline from Ben, archives the chat and starts another.
  ana.sessions = ana.sessions.map((item) => (item.id === "sess_a1" ? { ...item, archivedAt: 4_200 } : item));
  ana.sessions.push(chat("sess_a2", { title: "Second", messages: [{ id: "a2m", role: "user", text: "next", createdAt: 4_300 }] }));
  pass(ana, ANA, 4_400, anaCopy);

  // They meet: the sync carries each desk's own file across.
  const file = (dir: string, device: string) => path.join(dir, journalId, "journal", `${device}.jsonl`);
  cpSync(file(anaCopy, ANA.device), file(benCopy, ANA.device));
  cpSync(file(benCopy, BEN.device), file(anaCopy, BEN.device));
  const onAna = readTeamJournal(anaCopy, journalId);
  const onBen = readTeamJournal(benCopy, journalId);
  assert.deepEqual(onAna.map((item) => item.id), onBen.map((item) => item.id), "both copies agree");
  assert.equal(combineJournals(onAna, onBen, onAna).length, onAna.length, "same id is the same event");

  pass(ben, BEN, 5_000, benCopy);
  const benChat = ben.sessions.find((item) => item.id === "sess_a1")!;
  assert.equal(benChat.status, "running", "the running turn is not cut off");
  assert.equal(benChat.messages.at(-1)?.text, "streaming…");
  assert.equal(benChat.archivedAt, 4_200, "the archive label still lands");
  assert.ok(ben.sessions.some((item) => item.id === "sess_a2"), "Ana's offline chat arrives");

  pass(ana, ANA, 5_100, anaCopy);
  const anaChat = ana.sessions.find((item) => item.id === "sess_a1")!;
  assert.equal(anaChat.messages.find((item) => item.id === "b1")?.seat, "ben", "Ben's settled prompt arrives with his seat");
  assert.ok(!anaChat.messages.some((item) => item.id === "b2"), "his in-flight answer does not");
});

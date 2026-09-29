import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CredentialStore, protectStateCredentialsForSave, type SecretCipher } from "../electron/credential-store";
import { createHotDeskMemory, mergeDeskSave, prepareDeskSaveText, type DeskSaveHooks } from "../electron/hot-desk-save";
import { writeVersionedStateAsync, type PersistableState } from "../electron/state-persistence";
import { hotSavePayload } from "../src/lib/desk-persist";
import { sameJsonValue } from "../src/lib/same-json";
import type { AppState } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`locked:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^locked:/, ""),
};

type Chat = { id: string; status: string; messages: Array<{ id: string; role: string; text: string }> };

function chat(id: string, status: string, text: string): Chat {
  return { id, status, messages: [{ id: `${id}-m`, role: "assistant", text }] };
}

function hooksFor(vault: CredentialStore, full: { n: number }, one: { n: number }): DeskSaveHooks {
  return {
    protectSecrets: (state) => protectStateCredentialsForSave(state, vault),
    offloadFull: (state) => {
      full.n += 1;
      return structuredClone(state);
    },
    offloadOne: (session) => {
      one.n += 1;
      return session;
    },
  };
}

test("a hot tick reads the chats that moved and leaves the idle ones unread", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hot-save-"));
  const vault = new CredentialStore(path.join(root, "credentials.json"), cipher);
  const full = { n: 0 };
  const one = { n: 0 };
  const hooks = hooksFor(vault, full, one);
  const memory = createHotDeskMemory();
  const idle = Array.from({ length: 6 }, (_, index) => chat(`idle-${index}`, "idle", `idle-body-idle-${index}`));
  const liveA = chat("live-a", "running", "live-body-a");
  const liveB = chat("live-b", "needs-input", "live-body-b");
  const sessions = [...idle, liveA, liveB];
  const desk: PersistableState = {
    settings: { llms: { custom: { baseUrl: "https://example.test" } }, customBots: [] },
    sessions,
  };

  // The first payload of a run still carries every chat. There is no desk on
  // the main process to fold a partial list onto yet.
  const opening = hotSavePayload({
    state: desk as AppState,
    sessions: sessions as AppState["sessions"],
    activeSessionId: null,
    sent: new Map(),
    busy: true,
  });
  assert.equal(opening.hot, false);
  assert.equal(opening.body.sessionOrder, undefined);
  assert.equal((opening.body.sessions as unknown[]).length, sessions.length);

  const first = prepareDeskSaveText(desk, memory, hooks);
  assert.equal(first.fullDeskReads, 1, "the first save still offloads the whole desk");
  assert.equal(first.chatsRead, sessions.length, "the first save still serialises every chat");

  const resident = first.state;
  const residentSessions = resident.sessions as Chat[];
  const moved = residentSessions.map((session) => {
    if (session.id === "live-a") {
      return { ...session, messages: [...session.messages, { id: "tok-a", role: "assistant", text: "hot-token-a" }] };
    }
    if (session.id === "live-b") {
      return { ...session, messages: [...session.messages, { id: "tok-b", role: "assistant", text: "hot-token-b" }] };
    }
    return session;
  });
  const payload = hotSavePayload({
    state: {
      ...resident,
      settings: { llms: { custom: { apiKey: "super-secret", baseUrl: "https://example.test" } }, customBots: [] },
    } as unknown as AppState,
    sessions: moved as AppState["sessions"],
    activeSessionId: "live-a",
    sent: new Map(residentSessions.map((session) => [session.id, session as AppState["sessions"][number]])),
    busy: true,
  });
  assert.equal(payload.hot, true);
  const shipped = payload.body.sessions as Chat[];
  assert.deepEqual(shipped.map((session) => session.id).sort(), ["live-a", "live-b"]);
  assert.equal(JSON.stringify(payload.body).includes("idle-body-idle-0"), false, "idle transcripts must not cross onto the main process");
  assert.equal((payload.body.sessionOrder as string[]).length, sessions.length);

  const merged = mergeDeskSave(resident, payload.body);
  assert.equal(merged.refuse, false);
  const mergedSessions = merged.state.sessions as Chat[];
  assert.equal(mergedSessions[0], residentSessions[0], "an idle chat stays the object main already holds");
  assert.equal(mergedSessions.length, sessions.length);

  const hot = prepareDeskSaveText(merged.state, memory, hooks);
  assert.equal(full.n, 1, "the hot tick must not clone the desk");
  assert.equal(one.n, 2, "the hot tick offloads only the chats that moved");
  assert.equal(hot.fullDeskReads, 0);
  assert.equal(hot.chatsRead, 2, "two live chats moved, so two bodies are read");
  assert.ok(hot.chatsRead < (hot.state.sessions as unknown[]).length);
  assert.equal((hot.state.sessions as Chat[])[0], residentSessions[0]);
  assert.equal(hot.text.includes("super-secret"), false, "a hot tick still strips a key");
  assert.equal(hot.text.includes("idle-body-idle-0"), true);
  assert.equal(hot.text.includes("hot-token-a"), true);
  assert.equal(hot.text.includes("hot-token-b"), true);
  assert.equal(hot.text.includes("sessionOrder"), false);
  const parsed = JSON.parse(hot.text) as PersistableState;
  assert.equal(sameJsonValue(parsed, hot.state), true, "the assembled file is the desk that was prepared");
  assert.equal((parsed.sessions as Chat[]).length, sessions.length);

  const quietTick = prepareDeskSaveText(hot.state, memory, hooks);
  assert.equal(quietTick.chatsRead, 0, "a later tick that moved nothing reads no chat");
  assert.equal(quietTick.fullDeskReads, 0);
  assert.equal(one.n, 2);
  assert.equal(full.n, 1);

  const refused = mergeDeskSave(null, { sessions: [moved[0]], sessionOrder: moved.map((session) => session.id) });
  assert.equal(refused.refuse, true);

  fs.rmSync(root, { recursive: true, force: true });
});

test("a quiet desk still offloads every chat", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-quiet-save-"));
  const vault = new CredentialStore(path.join(root, "credentials.json"), cipher);
  const full = { n: 0 };
  const one = { n: 0 };
  const memory = createHotDeskMemory();
  const hooks = hooksFor(vault, full, one);
  const desk: PersistableState = {
    settings: { customBots: [] },
    sessions: [chat("a", "running", "one"), chat("b", "idle", "two"), chat("c", "idle", "three")],
  };
  prepareDeskSaveText(desk, memory, hooks);
  const settled: PersistableState = {
    settings: { customBots: [] },
    sessions: [chat("a", "idle", "one-done"), chat("b", "idle", "two"), chat("c", "idle", "three")],
  };
  const again = prepareDeskSaveText(settled, memory, hooks);
  assert.equal(again.fullDeskReads, 1, "no chat is running, so transcript offload still sees the whole desk");
  assert.equal(again.chatsRead, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a prepared hot save is written without stringifying the desk again", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-hot-write-"));
  const file = path.join(root, "workhorse-state.json");
  let protectedCalls = 0;
  try {
    await writeVersionedStateAsync(
      file,
      { sessions: [{ id: "a", text: "should-not-be-read" }, { id: "b", text: "idle-body" }] },
      () => {
        protectedCalls += 1;
        return { sessions: [] };
      },
      { rotateBackups: false, text: '{"sessions":[{"id":"a","text":"hot-token-a"}]}' },
    );
    const written = fs.readFileSync(file, "utf8");
    assert.equal(protectedCalls, 0, "the disk write must use the bytes the hot tick already built");
    assert.equal(written.includes("should-not-be-read"), false);
    assert.equal(written.includes("idle-body"), false);
    assert.equal(written.includes("hot-token-a"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the store and the main process both use the hot tick", () => {
  const store = fs.readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const effect = store.slice(store.indexOf("if (previous && deskPersistBodyEqual(previous, state)) return;"), store.indexOf("}, [ready, state]);"));
  assert.match(effect, /hotSavePayload\(/);
  assert.match(effect, /saveState\(payload\.body\)/);
  assert.doesNotMatch(effect, /saveState\(\{\s*\.\.\.state/);
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /prepareDeskSaveText\(/);
  assert.match(main, /text: prepared\.text/);
  assert.match(main, /const pending = writeVersionedStateAsync\(/);
  assert.match(main, /return stateSaves\.enqueue\(state\)/);
});

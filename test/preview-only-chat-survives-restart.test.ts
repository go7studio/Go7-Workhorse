import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dropDrafts, isDraftChat, listedChats, openDraft, retainChatPreview, sidebarKeepsChat } from "../src/lib/chats";
import { hotSavePayload } from "../src/lib/desk-persist";
import { sameSidebarSession, buildSidebarChatIndex } from "../src/lib/sidebar-index";
import { normalizeSession } from "../src/lib/session";
import { selectSessionPaneDesk, sameSessionPaneDesk } from "../src/lib/store-select";
import type { Store } from "../src/lib/store";
import type { AppState, Session } from "../src/lib/types";
import { mergeDeskSave } from "../electron/hot-desk-save";
import { readVersionedState, writeVersionedState } from "../electron/state-persistence";
import { createViewerAnnotationStore, viewerSession } from "../electron/viewer-host";

const blank = (id: string): Session => ({ id, projectId: null, provider: "grok", model: "grok-4.7", effort: "medium",
  title: "New chat", mode: "ask", sandbox: "workspace", environment: { kind: "local" }, status: "idle", messages: [], contextUsed: 0 });

test("explicit preview use retains a genuinely empty chat without inventing a prompt", () => {
  const chat = blank("preview-chat");
  const unused = blank("unused");
  const original = [chat, unused];
  assert.equal(isDraftChat(chat), true);
  assert.deepEqual(listedChats(original), []);
  const retained = retainChatPreview(original, chat.id);
  assert.notEqual(retained, original);
  assert.equal(retained[1], unused);
  assert.equal(retained[0].previewUsed, true);
  assert.equal(chat.previewUsed, undefined, "retention does not mutate a prior state snapshot");
  assert.equal(isDraftChat(retained[0]), false);
  assert.equal(sameSidebarSession(chat, retained[0]), false, "retention refreshes the sidebar index");
  assert.equal(buildSidebarChatIndex(retained).liveByProject.get(null)?.[0].id, chat.id);
  assert.deepEqual(listedChats(retained).map((row) => row.id), [chat.id]);
  assert.deepEqual(dropDrafts(retained).map((row) => row.id), [chat.id]);
  assert.equal(sidebarKeepsChat(retained[0], { projectId: null, archived: false }), true);
  assert.deepEqual(retained[0].messages, []);
  assert.equal(retained[0].composerDraft, undefined);
  assert.equal(retained[0].composerImages, undefined);
  const nextDraft = blank("next");
  assert.equal(openDraft([retained[0]], nextDraft).session.id, "next", "New chat cannot reuse the preview chat and orphan its pins");
  assert.equal(retainChatPreview(retained, chat.id), retained, "repeated open events do not rewrite the desk");
  assert.equal(retainChatPreview(retained, "missing"), retained);
  const archived = [{ ...chat, archivedAt: 1 }];
  assert.equal(retainChatPreview(archived, chat.id), archived);
});

test("normal desk save and restart keep a preview-only chat addressable with its persisted marks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wh-preview-chat-"));
  try {
    const chats = retainChatPreview([blank("preview-chat"), blank("unused")], "preview-chat");
    const saved = listedChats(chats);
    const state = { sessions: chats, activeSessionId: "preview-chat", projects: [] } as unknown as AppState;
    const payload = hotSavePayload({ state, sessions: saved, activeSessionId: "preview-chat", sent: new Map(), busy: false });
    const resident = mergeDeskSave(null, payload.body);
    assert.equal(resident.refuse, false);
    assert.equal(viewerSession(resident.state, "preview-chat").id, "preview-chat");
    const store = createViewerAnnotationStore(directory);
    store.save("preview-chat", [{ schema: "workhorse.annotation/v0", id: "pin", chatId: "preview-chat", mark: 1,
      kind: "2d-point", createdAt: "2026-01-01T00:00:00Z", note: "raise this corner", asset: { uri: "workhorse-media://local/?p=part.png", format: "png" },
      region2d: { imageSize: [100, 100], px: [40, 50] } }]);
    const file = path.join(directory, "state.json");
    writeVersionedState(file, resident.state, (value) => value);
    const restored = readVersionedState(file).state;
    const normalized = (restored.sessions as unknown[]).map((row) => normalizeSession(row)).filter((row): row is Session => row !== null);
    const listed = listedChats(normalized);
    assert.deepEqual(listed.map((row) => row.id), ["preview-chat"]);
    assert.equal(listed[0].previewUsed, true);
    assert.deepEqual(listed[0].messages, []);
    assert.equal(listed[0].composerDraft, undefined);
    assert.equal(viewerSession({ sessions: listed }, "preview-chat").id, "preview-chat");
    assert.equal(createViewerAnnotationStore(directory).load("preview-chat")[0].note, "raise this corner");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("only literal true enables preview retention when loading saved chats", () => {
  for (const previewUsed of [undefined, false, "true", 1, {}, []]) {
    const session = normalizeSession({ ...blank("chat"), previewUsed });
    assert.ok(session);
    assert.equal(session.previewUsed, undefined);
    assert.equal(isDraftChat(session), true);
  }
  assert.equal(normalizeSession({ ...blank("chat"), previewUsed: true })?.previewUsed, true);
});

test("the session pane keeps the current preview retention action", () => {
  const retainChatPreview = () => {};
  const store = { sessions: [blank("chat")], activeSessionId: "chat", projects: [], settings: {}, retainChatPreview } as unknown as Store;
  const selected = selectSessionPaneDesk(store);
  assert.equal(selected.retainChatPreview, retainChatPreview);
  assert.equal(sameSessionPaneDesk(selected, selectSessionPaneDesk(store)), true);
  assert.equal(sameSessionPaneDesk(selected, { ...selected, retainChatPreview: () => {} }), false);
});

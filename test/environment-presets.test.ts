import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  binaryProbeFromLookup,
  blenderStatusNote,
  normalizePresets,
  parseBlenderCommand,
  presetOn,
  serversForChatPresets,
  withPreset,
} from "../src/lib/environment-presets";
import { COMMANDS } from "../src/lib/commands";
import { mcpServersForSession } from "../src/lib/mcp-servers";
import { normalizeSession } from "../src/lib/session";
import type { McpServerConfig } from "../src/lib/types";

const handAdded: McpServerConfig = {
  name: "blender-mcp",
  command: "old",
  args: ["stale"],
  enabled: false,
};

describe("blender chat preset", () => {
  test("a missing lookup is not installed", () => {
    assert.deepEqual(binaryProbeFromLookup(undefined), { available: false, error: "Not found" });
    assert.deepEqual(binaryProbeFromLookup("  "), { available: false, error: "Not found" });
    assert.deepEqual(binaryProbeFromLookup("/opt/homebrew/bin/blender", "Blender 4.7.1"), {
      available: true,
      path: "/opt/homebrew/bin/blender",
      version: "Blender 4.7.1",
    });
  });

  test("commands and notes", () => {
    assert.equal(parseBlenderCommand("/blender"), "status");
    assert.equal(parseBlenderCommand("/blender on"), "on");
    assert.equal(parseBlenderCommand("/blender off"), "off");
    assert.equal(parseBlenderCommand("/blender status"), "status");
    assert.equal(parseBlenderCommand("/blender maybe"), null);
    assert.equal(COMMANDS.find((command) => command.name === "/blender")?.run, "blender");
    assert.equal(blenderStatusNote(false), "Blender is off for this chat.");
    assert.equal(presetOn(undefined, "blender"), false);
    assert.deepEqual(withPreset(undefined, "blender", true), ["blender"]);
    assert.equal(withPreset(["blender"], "blender", false), undefined);
  });

  test("saved chats keep only the blender preset", () => {
    const session = normalizeSession({
      id: "sess",
      provider: "cursor",
      model: "composer-2.5",
      presets: ["blender", "nope", "blender"],
    });
    assert.deepEqual(session?.presets, ["blender"]);
    assert.equal(normalizePresets("blender"), undefined);
    assert.equal(normalizeSession({ id: "sess", provider: "grok", model: "grok-4.6" })?.presets, undefined);
  });

  test("Cursor and Grok Bot both receive blender-mcp only while the chat has it on", () => {
    const offCursor = mcpServersForSession([handAdded], { provider: "cursor" });
    assert.deepEqual(offCursor.map((server) => server.name), []);

    const onCursor = mcpServersForSession([handAdded], { provider: "cursor", presets: ["blender"] });
    assert.equal(onCursor.length, 1);
    assert.equal(onCursor[0]?.name, "blender-mcp");
    assert.equal(onCursor[0]?.command, "uvx");
    assert.deepEqual(onCursor[0]?.args, ["blender-mcp"]);
    assert.equal(onCursor[0]?.enabled, true);

    const onBot = mcpServersForSession([], { provider: "custom", customBotId: "grok-bot", presets: ["blender"] });
    assert.equal(onBot[0]?.command, "uvx");
    assert.deepEqual(onBot[0]?.args, ["blender-mcp"]);

    const replaced = serversForChatPresets([handAdded, { name: "other", command: "other", args: [] }], ["blender"]);
    assert.deepEqual(replaced.map((server) => server.name), ["other", "blender-mcp"]);
    assert.equal(replaced.find((server) => server.name === "blender-mcp")?.enabled, true);
  });
});

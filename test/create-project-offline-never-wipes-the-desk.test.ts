import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { resetLinkStateCache } from "../electron/link-state";
import { handleWorkhorseRpc, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";

/**
 * With no desk to ask, workhorse_create_project writes the project into the
 * saved state itself. It read that file inside a catch that turned every
 * failure into `{}`, so a torn or locked state file became a desk holding one
 * project and no chats, written in place over the real one. The desk loads
 * its own file before its backups, and the next saves rotate the good copies
 * out. Every state file here is under a fresh temp directory.
 */

type Reply = { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };

async function offline<T>(body: (statePath: string, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-create-offline-"));
  const statePath = path.join(dir, "workhorse-state.json");
  const previous = { ...process.env };
  try {
    process.env.WORKHORSE_STATE_PATH = statePath;
    delete process.env.WORKHORSE_MCP_PROFILE;
    delete process.env.WORKHORSE_BRIDGE_URL;
    delete process.env.WORKHORSE_BRIDGE_TOKEN;
    delete process.env.WORKHORSE_FROM_SESSION;
    setWorkhorseDeskAsk(null);
    resetLinkStateCache();
    return await body(statePath, dir);
  } finally {
    process.env = previous;
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

function create(name: string): Promise<Reply> {
  return handleWorkhorseRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "workhorse_create_project", arguments: { name } },
  }) as Promise<Reply>;
}

test("a state file that cannot be read is refused, not replaced", async () => {
  await offline(async (statePath) => {
    for (const torn of ['{"sessions":[{"id":"sess_a","title":"Months of wo', "null", "[]"]) {
      writeFileSync(statePath, torn);
      const reply = await create("Parser");
      assert.match(reply.error?.message ?? "", /create-project failed.*Do not tell the user the project exists/);
      assert.equal(readFileSync(statePath, "utf8"), torn, "the desk's file was written over");
    }
  });
});

test("a desk that has never saved gets its first project, written whole", async () => {
  await offline(async (statePath) => {
    assert.equal(existsSync(statePath), false);
    const inPlace: string[] = [];
    const realWrite = fs.writeFileSync;
    const spy = mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === statePath) inPlace.push(String(args[0]));
      return realWrite(...args);
    });
    try {
      const reply = await create("Parser");
      assert.equal(reply.error, undefined, reply.error?.message);
    } finally {
      spy.mock.restore();
    }
    assert.deepEqual(inPlace, [], "the state was written in place, where a stop mid write tears it");
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as { projects?: Array<{ name: string }> };
    assert.deepEqual(saved.projects?.map((project) => project.name), ["Parser"]);
  });
});

test("an existing desk keeps every chat it had", async () => {
  await offline(async (statePath) => {
    writeFileSync(statePath, JSON.stringify({ sessions: [{ id: "sess_a", title: "Months of work" }], projects: [] }));
    const reply = await create("Parser");
    assert.equal(reply.error, undefined, reply.error?.message);
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as { sessions?: Array<{ id: string }>; projects?: Array<{ name: string }> };
    assert.deepEqual(saved.sessions?.map((session) => session.id), ["sess_a"]);
    assert.deepEqual(saved.projects?.map((project) => project.name), ["Parser"]);
  });
});

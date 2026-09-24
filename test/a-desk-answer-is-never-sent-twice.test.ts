import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { resetLinkStateCache } from "../electron/link-state";
import { watchPeerInbox, writeBridgeRecord, type PeerAsk } from "../electron/peer-inbox";
import { handleWorkhorseRpc, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";

/**
 * A Link helper posts to the desk bridge and, only when that request never
 * reached the desk, tries the file inbox instead. The failure was that every
 * refusal the desk sent back was run through the same test as a dropped socket:
 * the desk's own words were matched against "fetch", "abort", "socket". A
 * worker that failed with "fetch failed" came back as a 400, read as a
 * transport fault, and the same spawn went through the inbox a second time.
 *
 * Every desk here is a stand-in on a loopback port the test opened, and every
 * inbox is under a fresh temp directory.
 */

type Reply = { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };

async function onDesk<T>(
  answer: (res: http.ServerResponse) => void,
  body: (ctx: { dir: string; inbox: string; inboxAsks: PeerAsk[]; posts: () => number }) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "wh-desk-once-"));
  const statePath = path.join(dir, "workhorse-state.json");
  writeFileSync(statePath, JSON.stringify({ sessions: [], projects: [] }), "utf8");
  const previous = {
    state: process.env.WORKHORSE_STATE_PATH,
    profile: process.env.WORKHORSE_MCP_PROFILE,
    url: process.env.WORKHORSE_BRIDGE_URL,
    token: process.env.WORKHORSE_BRIDGE_TOKEN,
    from: process.env.WORKHORSE_FROM_SESSION,
  };
  let posts = 0;
  const server = http.createServer((req, res) => {
    posts += 1;
    req.resume();
    req.on("end", () => answer(res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const record = writeBridgeRecord(statePath, { url: `http://127.0.0.1:${port}`, token: "desk-token" });
  const inboxAsks: PeerAsk[] = [];
  const stop = watchPeerInbox(record.inbox, async (ask) => {
    inboxAsks.push(ask);
    return { text: "the same request, run a second time" };
  });
  try {
    process.env.WORKHORSE_STATE_PATH = statePath;
    delete process.env.WORKHORSE_MCP_PROFILE;
    delete process.env.WORKHORSE_BRIDGE_URL;
    delete process.env.WORKHORSE_BRIDGE_TOKEN;
    delete process.env.WORKHORSE_FROM_SESSION;
    setWorkhorseDeskAsk(null);
    resetLinkStateCache();
    return await body({ dir, inbox: record.inbox, inboxAsks, posts: () => posts });
  } finally {
    stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of [
      ["WORKHORSE_STATE_PATH", previous.state],
      ["WORKHORSE_MCP_PROFILE", previous.profile],
      ["WORKHORSE_BRIDGE_URL", previous.url],
      ["WORKHORSE_BRIDGE_TOKEN", previous.token],
      ["WORKHORSE_FROM_SESSION", previous.from],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetLinkStateCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

function spawnCall(folder: string, extra: Record<string, unknown> = {}): Promise<Reply> {
  return handleWorkhorseRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "workhorse_spawn_agent",
      arguments: { prompt: "Fix the flaky parser test and report what changed", folder, wait: true, ...extra },
    },
  }) as Promise<Reply>;
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

test("a desk refusal that mentions fetch is the answer, not a reason to spawn again", async () => {
  await onDesk(
    (res) => json(res, 400, { error: "Worker failed: fetch failed" }),
    async ({ dir, inbox, inboxAsks, posts }) => {
      const reply = await spawnCall(dir);
      assert.equal(posts(), 1, "the desk was asked once");
      assert.match(reply.error?.message ?? "", /Worker failed: fetch failed/, "the caller holds the desk's own words");
      assert.equal(inboxAsks.length, 0, "the inbox never saw the request");
      assert.deepEqual(readdirSync(inbox), [], "and no request file was written for it");
    },
  );
});

test("a 200 that carries an error is final too", async () => {
  await onDesk(
    (res) => json(res, 200, { error: "network is unreachable for this vendor" }),
    async ({ dir, inboxAsks }) => {
      const reply = await spawnCall(dir);
      assert.match(reply.error?.message ?? "", /network is unreachable/);
      assert.equal(inboxAsks.length, 0);
    },
  );
});

test("a desk that could not run the request at all (5xx) still falls back to the inbox", async () => {
  await onDesk(
    (res) => json(res, 500, { error: "handler threw" }),
    async ({ dir, inboxAsks }) => {
      const reply = await spawnCall(dir);
      assert.equal(reply.error, undefined, reply.error?.message);
      assert.equal(inboxAsks.length, 1, "a 5xx is the one desk reply that means the desk did not run it");
    },
  );
});

/**
 * The helper's own wait running out is not a dropped socket either: the desk
 * has held the request the whole time. The helper used to give up at a flat
 * ten minutes while the desk held a `timeoutSeconds: 1800` spawn for thirty,
 * then post the same spawn through the inbox. The clock is mocked so this runs
 * at once; the fetch stands in for a desk that never answers.
 */
test("the helper's own timeout does not send the request again, and waits past the desk's bound", async () => {
  await onDesk(
    () => undefined,
    async ({ dir, inbox, inboxAsks }) => {
      const realFetch = globalThis.fetch;
      let fetched = false;
      globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          fetched = true;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        })) as typeof fetch;
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        let settled: Reply | undefined;
        const pending = spawnCall(dir, { timeoutSeconds: 1800 }).then((reply) => {
          settled = reply;
        });
        // Read through a call: the reply lands from a callback the checker cannot follow.
        const answered = (): Reply | undefined => settled;
        const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
        for (let index = 0; index < 5_000 && !fetched; index += 1) await turn();
        assert.equal(fetched, true, "the helper posted to the desk");

        // Ten minutes, which is where the old flat bound gave up, is inside the
        // desk's thirty. Nothing may have happened yet.
        mock.timers.tick(10 * 60 * 1_000 + 1);
        for (let index = 0; index < 200; index += 1) await turn();
        assert.equal(answered(), undefined, "the helper gave up while the desk was still holding the spawn");

        // Past the desk's own bound, the helper stops and says so.
        mock.timers.tick(20 * 60 * 1_000 + 5_000);
        for (let index = 0; index < 5_000 && !answered() && readdirSync(inbox).length === 0; index += 1) await turn();
        assert.deepEqual(readdirSync(inbox), [], "the timed-out spawn was written to the inbox to run again");
        assert.equal(inboxAsks.length, 0);
        assert.ok(answered(), "the helper answered once its own bound passed");
        assert.match(answered()?.error?.message ?? "", /did not answer within 1805 s\. The request was not sent again\./);
        await pending;
      } finally {
        mock.timers.reset();
        globalThis.fetch = realFetch;
      }
    },
  );
});

/**
 * What a Link helper holds after ten reads.
 *
 * Builds a synthetic state file the size of a real desk's, stands a bridge in
 * front of it, drives ten tool calls through a helper and prints the helper's
 * RSS before and after. Nothing here touches the live desk: the state file is
 * written under a fresh temp directory and removed on the way out.
 *
 *   npx tsx scripts/link-read-memory.ts            # desk up
 *   npx tsx scripts/link-read-memory.ts --offline  # desk down, file fallback
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { startWorkhorseBridge } from "../electron/workhorse-bridge";
import { catalogSessions, matchListedChat } from "../src/lib/session-bridge";
import {
  boundLinkRead,
  linkReadMaxBytes,
  projectLinkCapacity,
  projectLinkChat,
  projectLinkChats,
  projectLinkStatus,
  type LinkReadRoute,
  type LinkReadState,
} from "../src/lib/link-read";

/** Hard ceiling on the whole run, so a stuck helper cannot sit on this machine. */
const RUN_BOUND_MS = 180_000;
const TARGET_BYTES = 29 * 1024 * 1024;
const CALLS = 10;

function synthState(): Record<string, unknown> {
  const sessions: Record<string, unknown>[] = [];
  const filler = "a synthetic worker line that stands in for a real transcript row. ".repeat(12);
  let bytes = 0;
  let index = 0;
  while (bytes < TARGET_BYTES) {
    const id = `sess_synth${index.toString(36).padStart(6, "0")}`;
    const messages = Array.from({ length: 60 }, (_, m) => ({
      id: `msg_${index}_${m}`,
      role: m % 3 === 0 ? "user" : "assistant",
      text: `${filler}${index}:${m}`,
      createdAt: 1_700_000_000_000 + index * 1_000 + m,
      ...(m % 7 === 0 ? { kind: "tool" } : {}),
    }));
    const session = {
      id,
      title: `Synthetic chat ${index}`,
      projectId: "proj_synth",
      provider: "claude",
      model: "claude-opus-5",
      status: index % 5 === 0 ? "running" : "idle",
      effort: "high",
      mode: "ask",
      createdAt: 1_700_000_000_000 + index,
      ...(index % 4 === 1 ? { parentId: sessions[0]?.id, workerName: `Worker${index}`, hidden: true } : {}),
      agentRun: { status: index % 5 === 0 ? "running" : "completed", startedAt: 1, finishedAt: 2, changedFiles: [] },
      messages,
    };
    sessions.push(session);
    bytes += Buffer.byteLength(JSON.stringify(session), "utf8");
    index += 1;
  }
  return {
    sessions,
    projects: [{ id: "proj_synth", name: "Synthetic", folders: [], references: [] }],
    settings: { customBots: [], mcpServers: [] },
    usage: [],
    externalTasks: { byId: {}, order: [] },
  };
}

function answerRead(state: LinkReadState, route: string, id: string, limit: number, from: string) {
  const snapshot: LinkReadState | { error: string } =
    route === "chats"
      ? projectLinkChats(state, from)
      : route === "capacity"
        ? projectLinkCapacity(state, from)
        : route === "status"
          ? projectLinkStatus(state, id, from)
          : route === "chat"
            ? projectLinkChat(state, id, limit, from, (slice, query, caller) => {
                const resolved = matchListedChat(catalogSessions(slice, { fromSessionId: caller, includeWorkers: true }), query);
                return "session" in resolved ? { id: resolved.session.id } : { error: resolved.error };
              })
            : { error: `unknown link read route “${route}”` };
  if ("error" in snapshot) return { error: snapshot.error };
  return boundLinkRead(JSON.stringify(snapshot), linkReadMaxBytes(route as LinkReadRoute));
}

function rssMb(pid: number): number {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Math.round((Number(out) / 1024) * 10) / 10;
  } catch {
    return -1;
  }
}

async function main(): Promise<number> {
  const offline = process.argv.includes("--offline");
  const script = path.resolve("dist-electron/workhorse-mcp.js");
  if (!fs.existsSync(script)) {
    console.error("Build first: npm run build");
    return 1;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-link-read-"));
  const statePath = path.join(dir, "workhorse-state.json");
  const state = synthState();
  // Stream it out. Holding the whole file as one string here would leave this
  // harness fatter than the helper it is trying to weigh.
  const handle = fs.openSync(statePath, "w");
  fs.writeSync(handle, '{"sessions":[');
  (state.sessions as unknown[]).forEach((session, index) => {
    fs.writeSync(handle, `${index ? "," : ""}${JSON.stringify(session)}`);
  });
  fs.writeSync(handle, `],"projects":${JSON.stringify(state.projects)},"settings":${JSON.stringify(state.settings)}`);
  fs.writeSync(handle, `,"usage":[],"externalTasks":${JSON.stringify(state.externalTasks)}}`);
  fs.closeSync(handle);
  const size = fs.statSync(statePath).size;

  const deskReads: string[] = [];
  let bridge: { url: string; token: string; close: () => void } | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  const stop = () => {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      bridge?.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const guard = setTimeout(() => {
    console.error(`bound of ${RUN_BOUND_MS} ms reached`);
    stop();
    process.exit(1);
  }, RUN_BOUND_MS);
  guard.unref();
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });

  try {
    if (!offline) {
      bridge = await startWorkhorseBridge(async (ask) => {
        // A desk answers more than reads. Anything else here is out of scope
        // for this measurement, and "unknown" is what the helper falls back on.
        if (ask.action !== "link-read") return { error: "unknown" };
        deskReads.push(`${ask.name}:${ask.message}`);
        return answerRead(state, ask.name ?? "", ask.message ?? "", ask.limit ?? 40, ask.fromSessionId ?? "");
      });
    }
    const first = (state.sessions as Array<{ id: string }>)[0].id;
    child = spawn(process.execPath, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        WORKHORSE_STATE_PATH: statePath,
        WORKHORSE_MCP_PROFILE: "external-runtime",
        WORKHORSE_FROM_SESSION: first,
        ...(bridge ? { WORKHORSE_BRIDGE_URL: bridge.url, WORKHORSE_BRIDGE_TOKEN: bridge.token } : {}),
      },
    });
    child.stderr?.resume();
    let replies = 0;
    const errors: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      replies += text.split("Content-Length:").length - 1;
      for (const hit of text.matchAll(/"error":\{[^}]*"message":"((?:[^"\\]|\\.)*)"/g)) errors.push(hit[1].slice(0, 160));
    });
    const trace: string[] = [];
    for (let step = 0; step < 5; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      trace.push(
        `${((step + 1) * 0.4).toFixed(1)}s helper=${rssMb(child.pid!)}MB harness=${rssMb(process.pid)}MB reads=${deskReads.length}`,
      );
    }
    const before = rssMb(child.pid!);

    // `--tool <name>` weighs one read on its own. The default walks all four.
    const only = process.argv[process.argv.indexOf("--tool") + 1];
    const calls = Array.from({ length: CALLS }, (_, index) => {
      const turn = process.argv.includes("--tool") ? ["list_chats", "read_chat", "query_capacity", "agent_status"].indexOf(only) : index % 4;
      if (turn === 0) return { name: "workhorse_list_chats", arguments: {} };
      if (turn === 1) return { name: "workhorse_read_chat", arguments: { chat: first, limit: 40 } };
      if (turn === 2) return { name: "workhorse_query_capacity", arguments: {} };
      return { name: "workhorse_agent_status", arguments: { id: first } };
    });
    for (const [index, params] of calls.entries()) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params });
      child.stdin?.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      trace.push(`call ${index + 1} ${params.name} rss=${rssMb(child.pid!)}MB`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = rssMb(child.pid!);
    console.log(
      JSON.stringify(
        {
          mode: offline ? "desk offline (file fallback)" : "desk up (reads through the bridge)",
          stateFileMb: Math.round((size / 1024 / 1024) * 10) / 10,
          sessions: (state.sessions as unknown[]).length,
          calls: CALLS,
          repliesSeen: replies,
          callsFailed: errors.length,
          errors: [...new Set(errors)],
          deskReads: deskReads.length,
          deskReplyKb: Object.fromEntries(
            [...new Set(deskReads.map((row) => row.split(":")[0]))].map((route) => {
              const answered = answerRead(state, route, first, 40, first);
              return [route, "text" in answered ? Math.round(Buffer.byteLength(answered.text, "utf8") / 1024) : -1];
            }),
          ),
          deskRoutes: [...new Set(deskReads.map((row) => row.split(":")[0]))],
          startup: trace,
          rssBeforeMb: before,
          rssAfterMb: after,
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    clearTimeout(guard);
    stop();
  }
}

void main().then((code) => process.exit(code));

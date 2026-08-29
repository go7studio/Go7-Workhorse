import fs from "node:fs";
import path from "node:path";
import { parseGrokBotLateMarker, type GrokBotLateMarker } from "../src/lib/grok-bot-shim";

/**
 * A Grok Bot answer that arrives after the shim gave the connection back.
 * The desk delivers it into the chat that asked, then clears the files.
 */
export type GrokBotLateAnswer = { reqId: string; sessionId: string; text: string; timedOutAt: number };

export type GrokBotLateIo = {
  readdir: (dir: string) => string[];
  readFile: (file: string) => string;
  unlink: (file: string) => void;
  exists: (file: string) => boolean;
};

function defaultIo(): GrokBotLateIo {
  return {
    readdir: (dir) => fs.readdirSync(dir),
    readFile: (file) => fs.readFileSync(file, "utf8"),
    unlink: (file) => fs.unlinkSync(file),
    exists: (file) => fs.existsSync(file),
  };
}

/** Every timed-out request whose answer has since landed. */
export function listGrokBotLateAnswers(inbox: string, io: GrokBotLateIo = defaultIo()): GrokBotLateAnswer[] {
  let names: string[] = [];
  try {
    names = io.readdir(inbox);
  } catch {
    return [];
  }
  const answers: GrokBotLateAnswer[] = [];
  for (const name of names) {
    if (!name.endsWith(".late.json")) continue;
    let marker: GrokBotLateMarker | undefined;
    try {
      marker = parseGrokBotLateMarker(JSON.parse(io.readFile(path.join(inbox, name))));
    } catch {
      continue;
    }
    if (!marker) continue;
    // The marker is only trusted beside the request the shim stamped: the same
    // id in its own file name, a request that still exists, the same chat on
    // both, and an answer naming that id. Anything else delivers nowhere.
    if (name !== `${marker.id}.late.json`) continue;
    let askedSession = "";
    try {
      const request = JSON.parse(io.readFile(path.join(inbox, `${marker.id}.req.json`))) as { sessionId?: unknown };
      askedSession = typeof request.sessionId === "string" ? request.sessionId : "";
    } catch {
      continue;
    }
    if (!askedSession || askedSession !== marker.sessionId) continue;
    const resPath = path.join(inbox, `${marker.id}.res.json`);
    if (!io.exists(resPath)) continue;
    let text = "";
    try {
      const data = JSON.parse(io.readFile(resPath)) as { id?: unknown; text?: unknown };
      if (!data || typeof data !== "object" || data.id !== marker.id) continue;
      text = typeof data.text === "string" ? data.text.trim() : "";
    } catch {
      continue;
    }
    if (!text) continue;
    answers.push({ reqId: marker.id, sessionId: marker.sessionId, text, timedOutAt: marker.timedOutAt });
  }
  return answers;
}

/** Called once the chat holds the answer. Files stay until then, so delivery is at-least-once. */
export function clearGrokBotLateAnswer(inbox: string, reqId: string, io: GrokBotLateIo = defaultIo()): void {
  if (!/^gb_[a-f0-9]{16}$/.test(reqId)) return;
  for (const file of [path.join(inbox, `${reqId}.late.json`), path.join(inbox, `${reqId}.res.json`), path.join(inbox, `${reqId}.req.json`)]) {
    try {
      io.unlink(file);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Watch the inbox and hand every ready late answer to the desk. The sweep also
 * runs at start, so answers that landed while the desk was closed still arrive.
 */
export function watchGrokBotLateAnswers(
  inbox: string,
  deliver: (answers: GrokBotLateAnswer[]) => void,
  io: GrokBotLateIo = defaultIo(),
  watchImpl: typeof fs.watch = fs.watch,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  const sweep = () => {
    timer = undefined;
    const ready = listGrokBotLateAnswers(inbox, io);
    if (ready.length) deliver(ready);
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(sweep, 500);
  };
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = watchImpl(inbox, schedule);
  } catch {
    /* inbox not created yet; the start sweep still runs */
  }
  schedule();
  return () => {
    if (timer) clearTimeout(timer);
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
  };
}

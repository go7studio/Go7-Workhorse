import fs from "node:fs";
import { atomicWriteJson } from "./state-persistence";
import {
  boundLinkHistory,
  linkHistoryFile,
  normalizeLinkHistory,
  type LinkCallRecord,
} from "../src/lib/link-history";

let chain: Promise<void> = Promise.resolve();

export function readLinkHistoryFile(statePath: string): LinkCallRecord[] {
  const file = linkHistoryFile(statePath);
  if (!file) return [];
  try {
    return normalizeLinkHistory(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

/** Append one row. Overlapping writes share one chain so a row is not dropped. */
export function appendLinkHistoryFile(statePath: string, record: LinkCallRecord): void {
  const file = linkHistoryFile(statePath);
  if (!file) return;
  chain = chain
    .then(() => {
      const next = boundLinkHistory([record, ...readLinkHistoryFile(statePath)]);
      atomicWriteJson(file, { version: 1, calls: next });
    })
    .catch(() => undefined);
}

export function flushLinkHistoryWrites(): Promise<void> {
  return chain;
}

/** One directory watch. The caller closes it. This does not poll. */
export function watchLinkHistory(statePath: string, onChange: () => void): () => void {
  const file = linkHistoryFile(statePath);
  if (!file) return () => undefined;
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const dir = slash < 0 ? "." : file.slice(0, slash);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const watcher = fs.watch(dir, (_event, filename) => {
      if (String(filename ?? "") !== "link-history.json") return;
      onChange();
    });
    return () => watcher.close();
  } catch {
    return () => undefined;
  }
}

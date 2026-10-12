import fs from "node:fs";
import path from "node:path";
import {
  combineJournals,
  isTeamId,
  sanitizePresence,
  sanitizeTeamEvent,
  type PresenceBeat,
  type TeamEvent,
} from "../src/lib/team";

/**
 * The team journal on disk, inside a folder both computers can see (a synced
 * or shared folder). Layout, per journal:
 *
 *   <folder>/<journalId>/journal/<deviceId>.jsonl   one file per desk, append-only
 *   <folder>/<journalId>/presence/<deviceId>.json   overwritten heartbeat, never replayed
 *
 * A desk writes only its own files, so two desks that wrote while apart never
 * fight over one file; reading combines every desk's file by event id.
 */
export type TeamFs = Pick<typeof fs, "mkdirSync" | "appendFileSync" | "readdirSync" | "readFileSync" | "writeFileSync" | "existsSync">;

function journalRoot(folder: string, journalId: string): string {
  if (!isTeamId(journalId)) throw new Error("Bad team journal id.");
  return path.join(folder, journalId);
}

export function appendTeamEvents(
  folder: string,
  journalId: string,
  device: string,
  events: readonly unknown[],
  fsx: TeamFs = fs,
): { written: number; refused: number } {
  if (!isTeamId(device)) throw new Error("Bad team device id.");
  const dir = path.join(journalRoot(folder, journalId), "journal");
  const lines: string[] = [];
  let refused = 0;
  for (const raw of events) {
    const clean = sanitizeTeamEvent(raw);
    if (!clean || clean.journal !== journalId || clean.device !== device) {
      refused += 1;
      continue;
    }
    lines.push(JSON.stringify(clean));
  }
  if (lines.length === 0) return { written: 0, refused };
  fsx.mkdirSync(dir, { recursive: true });
  fsx.appendFileSync(path.join(dir, `${device}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  return { written: lines.length, refused };
}

export function readTeamJournal(folder: string, journalId: string, fsx: TeamFs = fs): TeamEvent[] {
  const dir = path.join(journalRoot(folder, journalId), "journal");
  if (!fsx.existsSync(dir)) return [];
  const lists: TeamEvent[][] = [];
  for (const name of fsx.readdirSync(dir) as string[]) {
    const device = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
    if (!isTeamId(device)) continue;
    let text = "";
    try {
      text = String(fsx.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const rows: TeamEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const clean = sanitizeTeamEvent(JSON.parse(line));
        // A desk's file speaks only for that desk.
        if (clean && clean.journal === journalId && clean.device === device) rows.push(clean);
      } catch {
        // A half-written last line from a sync in progress is read next time.
      }
    }
    lists.push(rows);
  }
  return combineJournals(...lists);
}

export function writeTeamPresence(folder: string, journalId: string, beat: PresenceBeat, fsx: TeamFs = fs): boolean {
  const clean = sanitizePresence(beat);
  if (!clean) return false;
  const dir = path.join(journalRoot(folder, journalId), "presence");
  fsx.mkdirSync(dir, { recursive: true });
  fsx.writeFileSync(path.join(dir, `${clean.device}.json`), JSON.stringify(clean), "utf8");
  return true;
}

export function readTeamPresence(folder: string, journalId: string, fsx: TeamFs = fs): PresenceBeat[] {
  const dir = path.join(journalRoot(folder, journalId), "presence");
  if (!fsx.existsSync(dir)) return [];
  const beats: PresenceBeat[] = [];
  for (const name of fsx.readdirSync(dir) as string[]) {
    const device = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    if (!isTeamId(device)) continue;
    try {
      const beat = sanitizePresence(JSON.parse(String(fsx.readFileSync(path.join(dir, name), "utf8"))));
      if (beat && beat.device === device) beats.push(beat);
    } catch {
      continue;
    }
  }
  return beats;
}

/** This computer's team device id. Made once, kept beside the desk file, never copied by a join. */
export function teamDeviceId(userData: string, make: () => string, fsx: TeamFs = fs): string {
  const file = path.join(userData, "team-device.json");
  try {
    const saved = JSON.parse(String(fsx.readFileSync(file, "utf8"))) as { device?: unknown };
    if (isTeamId(saved.device)) return saved.device;
  } catch {
    // First run on this computer.
  }
  const device = make();
  fsx.mkdirSync(userData, { recursive: true });
  fsx.writeFileSync(file, JSON.stringify({ device }), "utf8");
  return device;
}

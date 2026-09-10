import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withDeskToolEnv, withoutWorkhorsePrivateEnv } from "./desk-path";
import { groupSpawnOptions, stopProcessTree, trackProcessGroup } from "./process-registry";

export type TerminalEvent =
  | { type: "output"; sessionId: string; data: string }
  | { type: "exit"; sessionId: string; code: number | null };

type TerminalSlot = { cwd: string; child: ChildProcessWithoutNullStreams };

function validCwd(cwd: string): boolean {
  if (!path.isAbsolute(cwd) || !fs.existsSync(cwd)) return false;
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

export class TerminalHost {
  private slots = new Map<string, TerminalSlot>();

  start(sessionId: string, cwd: string, emit: (event: TerminalEvent) => void): { ok: boolean; message?: string } {
    const id = sessionId.trim();
    if (!id) return { ok: false, message: "Terminal needs a chat." };
    if (!validCwd(cwd)) return { ok: false, message: "Terminal folder is not available." };
    const existing = this.slots.get(id);
    if (existing && path.resolve(existing.cwd) === path.resolve(cwd) && !existing.child.killed) return { ok: true };
    this.stop(id);

    const windows = process.platform === "win32";
    const command = windows ? process.env.ComSpec?.trim() || "C:\\Windows\\System32\\cmd.exe" : process.env.SHELL?.trim() || "/bin/sh";
    const args = windows ? ["/d", "/q", "/k"] : ["-i"];
    try {
      const child = spawn(command, args, {
        cwd,
        // The same environment every vendor launch gets: the person's normal
        // login and PATH, without the desk's own bridge token, state paths or
        // vault-held vendor login. This shell was the one spawn on the desk
        // that skipped the filter, so `printenv WORKHORSE_BRIDGE_TOKEN` in the
        // built-in Terminal printed the credential that authenticates calls
        // into Workhorse.
        env: withDeskToolEnv(withoutWorkhorsePrivateEnv(process.env)),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // An interactive shell is the shortest route to a runaway on this desk:
        // whatever the person types starts under it. It leads its own group.
        ...groupSpawnOptions(),
      });
      trackProcessGroup(child, id, Date.now, "tree");
      this.slots.set(id, { cwd, child });
      const output = (data: Buffer | string) => emit({ type: "output", sessionId: id, data: data.toString() });
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      child.once("error", (error) => output(`${error.message}${os.EOL}`));
      child.once("exit", (code) => {
        if (this.slots.get(id)?.child === child) this.slots.delete(id);
        emit({ type: "exit", sessionId: id, code });
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  write(sessionId: string, text: string): { ok: boolean; message?: string } {
    const child = this.slots.get(sessionId)?.child;
    if (!child?.stdin.writable) return { ok: false, message: "Terminal is not running." };
    child.stdin.write(text.endsWith("\n") ? text : `${text}${os.EOL}`);
    return { ok: true };
  }

  stop(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    this.slots.delete(sessionId);
    /*
     * The tree, not the shell, and not only the shell's group. `child.kill()`
     * closed the terminal and left everything the person had started in it
     * running. The group alone is not enough either: a shell with its own
     * session has job control, and job control puts `sleep 5 &` in a group of
     * its own that the shell's group kill never reaches.
     */
    if (slot) stopProcessTree(slot.child);
  }

  disposeAll(): void {
    for (const id of [...this.slots.keys()]) this.stop(id);
  }
}

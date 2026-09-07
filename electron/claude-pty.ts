import path from "node:path";

/**
 * A pseudo-terminal for one child, with no native dependency.
 *
 * `claude setup-token` is a terminal program. Spawned with a pipe or with
 * stdin ignored it prints nothing at all — not the URL, not a prompt, not an
 * error — and waits, so the desk's sign-in button started a process that sat
 * silent until it was killed. Given a real terminal the same command opens the
 * browser itself and prints the token when the person approves.
 *
 * Python's `pty` is the terminal every Mac and Linux desk already has. The
 * program below forks a PTY, gives it a wide window so a long token is never
 * wrapped across lines, relays the child's output to stdout and anything the
 * desk writes back into the terminal, and exits with the child's own code.
 */
export const PTY_RELAY = `import errno, fcntl, os, pty, select, struct, sys, termios

def main():
    argv = sys.argv[1:]
    if not argv:
        return 2
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except Exception:
            pass
        os._exit(127)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 120, 400, 0, 0))
    except Exception:
        pass
    out = sys.stdout.buffer
    keys = sys.stdin.fileno()
    watch = [fd, keys]
    while True:
        try:
            ready = select.select(watch, [], [])[0]
        except (OSError, ValueError) as err:
            if getattr(err, "errno", None) == errno.EINTR:
                continue
            break
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            out.write(data)
            out.flush()
        if keys in ready:
            try:
                typed = os.read(keys, 4096)
            except OSError:
                typed = b""
            if typed:
                os.write(fd, typed)
            else:
                watch = [fd]
    try:
        os.close(fd)
    except OSError:
        pass
    status = os.waitpid(pid, 0)[1]
    if hasattr(os, "waitstatus_to_exitcode"):
        try:
            return os.waitstatus_to_exitcode(status)
        except ValueError:
            return 1
    return status >> 8

sys.exit(main())
`;

export type PtyRunnerInput = {
  env?: NodeJS.Dict<string>;
  platform?: NodeJS.Platform;
  pathDirs?: string[];
  existsSync?: (filePath: string) => boolean;
  /** Follows symlinks, so a link to the stub is still the stub. Injected for tests. */
  realpathSync?: (filePath: string) => string;
};

/**
 * On a Mac `/usr/bin/python3` is a stub when the developer tools are not
 * installed: running it pops the system's install dialog instead of a Python.
 * A sign-in button must never do that, so the stub counts only when a
 * developer directory that carries the real one is on disk.
 */
const MAC_DEVELOPER_PYTHONS = [
  "/Library/Developer/CommandLineTools/usr/bin/python3",
  "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
];

/**
 * The command that runs `argv` under a pseudo-terminal, or null when this desk
 * has no way to make one. Windows has no `pty` module; the caller falls back
 * to the person's own terminal and a pasted token.
 */
export function ptyRunner(
  argv: string[],
  input: PtyRunnerInput = {},
): { command: string; args: string[] } | null {
  const platform = input.platform ?? process.platform;
  if (platform === "win32" || argv.length === 0) return null;
  const env = input.env ?? process.env;
  const existsSync = input.existsSync ?? (() => false);
  const realpathSync = input.realpathSync ?? ((filePath: string) => filePath);
  const dirs = input.pathDirs ?? (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const name of ["python3", "python3.13", "python3.12", "python3.11"]) {
      candidates.push(path.join(dir, name));
    }
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    // Follow the link before judging it: `~/bin/python3 -> /usr/bin/python3`
    // is the stub wearing another name, and would still pop the dialog.
    let resolved = path.resolve(candidate);
    try {
      resolved = path.resolve(realpathSync(candidate));
    } catch {
      /* a link to nowhere is judged by its own path */
    }
    const stub =
      platform === "darwin" &&
      resolved === "/usr/bin/python3" &&
      !MAC_DEVELOPER_PYTHONS.some((real) => existsSync(real));
    if (stub) continue;
    return { command: candidate, args: ["-c", PTY_RELAY, ...argv] };
  }
  return null;
}

/**
 * Terminal programs draw with escape sequences, and this one moves the cursor
 * between words, so the raw stream is not text to search. Strip the sequences
 * before looking for anything in it.
 */
export function stripTerminalCodes(text: string): string {
  return text
    // OSC: ESC ] ... BEL or ESC backslash.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    // CSI: ESC [ ... final byte. This is the one the CLI emits between words to
    // place the cursor, so a token can sit on either side of it.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Every other two-byte escape.
    .replace(/\x1b[@-Z\\-_]/g, "")
    // Leftover control bytes, keeping newline and tab.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r/g, "\n");
}

/**
 * Whether the terminal is asking the person to press ENTER.
 *
 * The CLI places each word with a cursor escape rather than a space, so the
 * stripped text reads "pressENTERtoopen". Matching ignores spacing for that
 * reason, and the desk answers on the person's behalf.
 */
export function wantsEnter(text: string): boolean {
  return /pressenter/i.test(stripTerminalCodes(text).replace(/\s+/g, ""));
}

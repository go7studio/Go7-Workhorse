import fs from "node:fs";

/**
 * Node reports a working directory that does not exist by throwing ENOENT and
 * naming the *command* — so a chat whose project folder had moved failed with
 * `spawn /Users/…/.grok/bin/grok ENOENT` while that binary sat there, present
 * and executable. The message sent whoever read it hunting for a missing CLI.
 *
 * Every vendor host runs its agent through this first, so a folder that is gone
 * says so, and says which one.
 */
export function spawnCwd(cwd: string | undefined, exists = fs.existsSync): string | undefined {
  const folder = cwd?.trim();
  if (!folder) return undefined;
  if (exists(folder)) return folder;
  throw new Error(
    `The project folder is missing: ${folder} — relink it in the project, or point this chat at a folder that exists.`,
  );
}

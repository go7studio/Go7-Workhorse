# Go7 Workhorse

A native desktop shell for coding agents. Each vendor stays its own process. This app is the window, the project, the chats, the `/` palette, and the permission bar.

This repository is public. Ship production code, tests, and docs a stranger
may read. Do not add operator Bibles, studio memory, or working papers here.
`docs/FEATURES.md` is the public inventory.

## Shape

- **A project is a named container.** Create it with a name only. Folders and other references are optional links, added later.
- **Chats belong to a project.** Rename, archive, delete, or drag a chat onto another project. Archived chats stay on that project until unarchived.
- **A chat starts, then you pick the model.** The composer menu holds vendor, model (Grok 4.5 / 4.6 / Build, Claude, Codex), and brain effort. Do not put a brain picker in front of New chat.
- **Tools** (Figma, GitHub, and so on) attach to a runtime. They are not extra tabs.
- Permissions are one inbox. Each click is translated to that vendor’s own protocol later.
- **Settings holds Profile, connected LLMs, skills, routing, learning, usage, watch.** Usage is not a top-level sidebar item. Adapters call `recordUsage`. Do not invent tokens for preview chats.
- Do not merge subscriptions, context, or sandboxes across vendors.

## Layout

```
electron/     desktop process (window, folder picker, persistence)
src/lib/      types, store, commands, provider catalog
src/ui/       the shell
src/styles/   design tokens and layout
```

## Rules

- Keep the UI learnable: few files, plain names, no extra frameworks.
- Adapters live behind `src/lib/providers.ts`. Do not call vendor CLIs from React components.
- Grok, Codex, Claude, and Cursor are live ACP adapters (Electron main only). Custom is live HTTP from a pasted Anthropic/OpenAI-compatible URL and key. Never invent a login. Cursor usage is two pools (Composer/Cursor Grok vs Other Models). Do not fold Cursor into Grok.
- Apple-like means space, hairlines, and short motion — not decoration.

## Working rules

More than one agent works this repo at once. Each rule below is here because
breaking it cost real time.

- **Never leave work uncommitted.** Commit to a branch when you stop. A dozen
  modified files in a shared checkout is invisible to everyone else, blocks
  branch switching, and is one careless command from gone.
- **One tree per agent.** Take a `git worktree` or a clone, and give it its own
  `npm ci`. Never symlink `node_modules` from another tree: `npm ci` follows the
  link and empties the tree it points at.
- **Stage what you changed.** `git add -A` in a shared checkout sweeps up other
  people's work and stray files. It is how a `node_modules` symlink reached the
  repo.
- **Rebase, never force.** Your base is probably behind. `git rebase origin/main`
  merges three ways and keeps both sides; a force push does not.
- **Tests must not read the machine they run on.** Inject `existsSync`/`readdir`,
  or assert against `ROOT`. Never a home directory, and never a bare `/opt/...`
  path — those pass on one laptop and fail on every other machine.
- **Green locally is not green.** The suite runs on Windows and macOS in CI.
  `path.join` gives backslashes on one of them, and `node.exe` is tried before
  `node`. Say which platform a test means.
- **Check the artifact, not the exit code.** A build can exit 0 and ship a
  hollow app. Count what should be inside before you install or publish.

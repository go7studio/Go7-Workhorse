# Go7 Workhorse

A native desktop shell for coding agents. Each vendor stays its own process. This app is the window, the project, the chats, the `/` palette, and the permission bar.

## Shape

- **A project is a named container.** Create it with a name only. Folders and other references are optional links, added later.
- **Chats belong to a project.** Rename, archive, delete, or drag a chat onto another project. Archived chats stay on that project until unarchived.
- **A chat starts, then you pick the model.** The composer menu holds vendor, model (Grok 4.5 / 4.6 / Build, Claude, Codex), and brain effort. Do not put a brain picker in front of New chat.
- **Tools** (Figma, GitHub, and so on) attach to a runtime. They are not extra tabs.
- Permissions are one inbox. Each click is translated to that vendor’s own protocol later.
- **Settings holds profile, connected LLMs, custom API, and usage.** Usage is not a top-level sidebar item. Adapters call `recordUsage`. Do not invent tokens for preview chats.
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
- Grok, Codex, and Claude are live ACP adapters (Electron main only). Custom is live HTTP from a pasted Anthropic/OpenAI-compatible URL and key. Never invent a login.
- Apple-like means space, hairlines, and short motion — not decoration.

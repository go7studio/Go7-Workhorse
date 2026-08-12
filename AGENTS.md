# Go7 Workhorse

A native desktop shell for coding agents. Each vendor stays its own process. This app is the window, the project folder, the `/` palette, and the permission bar.

## Shape

- **Runtimes** get a tab: Grok, Claude, Codex, or a custom bot.
- **Tools** (Figma, GitHub, and so on) attach to a runtime. They are not extra tabs.
- A session always has a **project directory**. No homeless chats.
- Permissions are one inbox. Each click is translated to that vendor’s own protocol later.
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
- Preview sessions may echo locally. Never pretend a provider is signed in.
- Apple-like means space, hairlines, and short motion — not decoration.

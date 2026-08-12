# Goal

Scaffold **Go7 Workhorse** as a native desktop shell — not a website — that can later host Grok, Claude, Codex, and custom bots in one window.

This slice is done when all of the following are true:

1. The GitHub repository lives at `https://github.com/Spikey222/Go7-Workhorse`.
2. The app launches as its own desktop window (Electron). It does not depend on a browser tab.
3. A user can choose a project directory (native folder picker). Sessions are bound to that folder.
4. Provider slots exist for Grok, Claude, Codex, and a custom bot. They are honest stubs: not marked connected until an adapter exists.
5. `/` opens a command palette. App commands (`/new`, `/project`, `/providers`, permission modes, `/quit`) work in the window.
6. A unified permission bar can present Allow once / Allow for session / Deny.
7. The UI is quiet, Apple-like, and readable: system type, soft materials, short motion, no chrome clutter.

Out of scope for this slice: live ACP adapters, subscription login, and talking to a real model.

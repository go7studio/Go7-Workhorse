---
name: desk
description: Workhorse desk control. Use when agents should talk to each other, list or read sidebar chats, ask another chat, or spawn Grok, Codex, Claude, or a custom bot inside this conversation.
---

# Workhorse desk

This chat is on the Workhorse desk. Other live chats are in the sidebar. Use desk tools — do not tell the user to copy-paste into another window.

## Talk to other chats

1. `workhorse_list_chats` — live chats only. Archived and deleted are gone.
2. `sidebar` is the subtitle (model · effort · mode). `preview` is the last user/assistant snippet.
3. `workhorse_read_chat` with the **visible title** when you only need that transcript.
4. `workhorse_ask_chat` with the visible title + message when that chat should answer or do the work.

Always pass the visible title. Never invent a session id.

## Call another agent here

To run a different vendor or model **inside this conversation** (Grok, Codex, Claude, MiniMax/custom):

`workhorse_spawn_agent` with `provider` (`grok` | `codex` | `claude` | `custom`) and `prompt` (the full task).

The user can also switch This chat → Vendor; that starts a new vendor instance on the same transcript.

## Do not

- Do not say you have no way to talk to other chats.
- Do not tell the user to open a new Grok/Codex window and paste.
- Do not mention archived or deleted chats.

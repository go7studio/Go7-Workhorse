# Grok Bot

Grok Bot has two separate Workhorse connections. You can use the first one
without setting up the second.

| Connection | What it does | Required? |
| --- | --- | --- |
| Workhorse Link | Lets Grok Bot call Workhorse through MCP or the `workhorse` command. The local watcher also carries queued Grok Bot messages. | Yes, for Grok Bot to call Workhorse |
| Instant replies | Lets Workhorse wake Grok Bot as soon as you send it a message. | No. Finish it now or later. |

## Workhorse Link and the watcher

In Workhorse, open **Settings → LLMs → Workhorse Link**, then choose
**Connect Grok Bot**. Paste the one-shot instructions into Grok Bot once.
Those instructions connect the MCP tools and the local command without adding
another vendor or sharing subscriptions.

After that, Grok Bot can ask Workhorse to read or ask chats, check capacity,
and delegate work. The local watcher carries queued messages even if instant
replies are not configured.

## Instant chat walkthrough

This optional step gives Workhorse a private way to wake one Grok Bot for a
quick reply.

1. In Grok Bot, select the bot you are connecting.
2. Ask it: **Create a routine named Workhorse that runs when a webhook fires.**
3. Make sure the routine is active.
4. Open the routine, then open **When a webhook fires**.
5. Click **POST to** and copy the complete value.
6. Click **key** and copy the complete value.
7. In Workhorse, open **Settings → LLMs → Grok Bot → Finish instant chat**.
8. Paste both values and choose **Connect instant replies**.

You can hide this setup at any time. Grok Bot remains available through
Workhorse Link and the watcher, and **Finish instant chat** remains in LLMs.

## Keep the two keys separate

- The Grok Bot webhook key only wakes the selected bot. Workhorse stores it in
  its private user data and hides both fields after saving.
- The loopback token protects completions on `127.0.0.1:8787`. Workhorse mints
  and injects it automatically. It is not the webhook key.
- Never paste either secret into a Grok Bot chat, agent memory, documentation,
  git, or a remote machine. Never expose the loopback service on `0.0.0.0`.

Deleting and recreating a routine with the same name may reuse its key. If a
key may have leaked, use a different routine name or confirm that Grok Bot
rotated the key before reconnecting it.

# Workhorse Link

One way in for every outside app. Codex, Claude Code, Grok, OpenClaw, Hermes
and anything that speaks MCP launch the same packaged helper and get the same
small toolset. One MCP server, one restricted profile, one installer, one
versioned contract.

## Connect

**Settings → LLMs → Workhorse Link.** Connect Codex, Connect Claude, Connect
Grok, Connect OpenClaw, Connect Hermes. Each writes the same launch into that
app's own MCP config through its own tool (`codex mcp add`, `claude mcp add`,
`grok mcp add`, `openclaw mcp set`, Hermes `config.yaml`). Nothing else is
written, and no token is stored.

**Any other MCP client:** Copy generic MCP configuration, and paste it into
that client's servers list:

```json
{
  "mcpServers": {
    "workhorse": {
      "command": "<path to the installed Go7 Workhorse binary>",
      "args": ["<path to workhorse-mcp.js inside the app>"],
      "env": {
        "WORKHORSE_MCP_PROFILE": "external-runtime",
        "WORKHORSE_STATE_PATH": "<path to workhorse-state.json>",
        "ELECTRON_RUN_AS_NODE": "1"
      }
    }
  }
}
```

Connecting an app is not adding a vendor. Claude Code connected through Link
has no Claude provider, login, context or Usage ring of its own; Workhorse
calling Claude's model through ACP is the other direction and stays separate.

## Call `workhorse_capabilities` first

```json
{
  "protocolVersion": 1,
  "desk": "online",
  "capabilities": ["capacity.read", "chats.read", "workers.delegate", "workers.follow_up"],
  "tools": [
    "workhorse_capabilities", "workhorse_list_chats", "workhorse_read_chat",
    "workhorse_query_capacity", "workhorse_delegate", "workhorse_continue_mission",
    "workhorse_agent_status", "workhorse_ask_chat"
  ]
}
```

`protocolVersion` changes only when a listed tool's shape changes. `desk` is
`offline` when no Workhorse window is running; reads still answer from the
last saved state, delegation does not.

## The tools

| Tool | Does | Changes the desk |
| --- | --- | --- |
| `workhorse_capabilities` | the contract above | no |
| `workhorse_list_chats` | chats, by project | no |
| `workhorse_read_chat` | one chat's transcript | no |
| `workhorse_query_capacity` | leftover and callability per bot; advisory | no |
| `workhorse_delegate` | run one task through Workhorse as a worker; Workhorse picks the worker | yes |
| `workhorse_continue_mission` | follow up after a finished wave with only the remaining work; an assessment-only pass starts a fresh worker for remaining implementation on the same mission | yes |
| `workhorse_agent_status` | one worker's state | no |
| `workhorse_ask_chat` | a message to a live chat | yes |

Not available through Link: credentials, permissions, deletes, renames,
custom-bot setup, Watch permits, project mutation. They are not listed and
a call is refused.

`workhorse_capabilities` and `tools/list` name those eight. Older names
(`workhorse_spawn_agent`, `workhorse_list_bots`, `workhorse_list_projects`,
`workhorse_list_agents`, `workhorse_list_external_agents`,
`workhorse_await_agents`, `workhorse_cancel_agent`) still answer so a harness
that already calls them is not refused. New harnesses should use the eight.

When Settings → Learning is on, each Link call is stored on this machine as
agent evidence. Keys and chat text stay out.

## Execution contract

A call that changes the desk carries:

```json
{ "fromSessionId": "…", "traceId": "…", "idempotencyKey": "…" }
```

`fromSessionId` is the Workhorse chat the work belongs to, from
`workhorse_list_chats`; without one, delegation returns `context_required`.
Send `traceId` and `idempotencyKey`; Workhorse creates any you leave out and
echoes the three it ran under in the reply's `envelope`. A retry with the same
`idempotencyKey` returns the first answer: not a second worker from
`delegate`, not a second pass from `continue_mission`, not the same message
posted twice by `ask_chat`.

Workhorse owns hop counting and cycle detection. Capacity is advisory:
delegation rechecks Watch, permissions, connection and callability every
time.

## Without MCP

The same helper is a JSON CLI. Every subcommand is one tool call through the
same handler — same permissions, same answers.

**Settings → LLMs → Workhorse Link → Install workhorse command** writes a
launcher with this install's exact paths and puts `workhorse` on your PATH
where that needs no password (`/usr/local/bin` or `/opt/homebrew/bin` on
macOS). If neither is writable, it shows the one `ln -s` to run. On Windows it
writes `workhorse.cmd` and names the folder to add to PATH; it does not edit
PATH for you.

```bash
workhorse capabilities
workhorse capacity --callable
workhorse delegate --chat <sessionId> --task "Review this change" --key <idempotencyKey>
workhorse status <workerId>
workhorse follow-up <workerId> "Check the failing test" --chat <sessionId>
```

Without the command, the same calls are
`"<binary>" "<workhorse-mcp.js>" link …` with the three environment variables
from the MCP config set. Output is JSON on stdout; exit 1 with `{"error": …}`
on failure.

# Workhorse Link

One way in for every outside app. Codex, Claude Code, Grok, OpenClaw, Hermes
and anything that speaks MCP launch the same packaged helper and get the same
bounded toolset. One MCP server, one restricted profile, one installer, one
versioned contract.

## Connect

**Settings → LLMs → Workhorse Link.** Connect Codex, Connect Claude, Connect
Grok, Connect Grok Bot, Connect OpenClaw, Connect Hermes. Codex, Claude, Grok,
OpenClaw and Hermes write the same launch into that app's own MCP config
through its own tool (`codex mcp add`, `claude mcp add`, `grok mcp add`,
`openclaw mcp set`, Hermes `config.yaml`). **Connect Grok Bot** copies the
same launch plus install steps for this computer (Mac or Windows); paste it
into Grok Bot once and tell it to save in permanent agent memory (the remote
box is scratch). The handoff replaces older leftover setup and tells Grok Bot
to keep a local, non-LLM weekly-usage exporter current. It requires no fixed
Grok Bot model; the selected model only needs local MCP/CLI tool calling, and
Workhorse routes delegated workers. Workhorse keeps a private loopback shim on Mac and Windows.
Each install has its own loopback token; 8787 is not a shared open API. A
webhook key, if used, lives only in `grok-bot-wake.json` on that computer.
Grok Bot writes `grok-bot-leftover.json` from its real runtime reading now, on
launch, after work, and every 15 minutes while active. Workhorse only reads it;
missing, expired, or older-than-30-minute readings stay unknown. Connecting is
not adding a vendor. No token is stored.

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
  "protocolVersion": 2,
  "desk": "online",
  "capabilities": [
    "capacity.read", "chats.read", "workers.delegate", "workers.follow_up",
    "local.hosts.read", "local.capabilities.read", "local.jobs.submit",
    "local.jobs.read", "local.jobs.cancel", "local.artifacts.transfer",
    "local.continuations.dispatch"
  ],
  "tools": [
    "workhorse_capabilities", "workhorse_list_chats", "workhorse_read_chat",
    "workhorse_query_capacity", "workhorse_delegate", "workhorse_continue_mission",
    "workhorse_agent_status", "workhorse_ask_chat", "workhorse_local_hosts",
    "workhorse_local_capabilities", "workhorse_local_upload",
    "workhorse_local_chat", "workhorse_local_generate_3d", "workhorse_local_job",
    "workhorse_local_cancel", "workhorse_local_artifact", "workhorse_local_materialize",
    "workhorse_local_continue"
  ],
  "followThrough": {
    "newSlice": "workhorse_delegate",
    "namedWorker": "workhorse_ask_chat",
    "later": "workhorse_agent_status"
  }
}
```

`protocolVersion` changes only when a listed tool's shape changes. `desk` is
`offline` when no Workhorse window is running; reads still answer from the
last saved state, delegation does not.

## The tools

| Tool | Does | Changes the desk |
| --- | --- | --- |
| `workhorse_capabilities` | the contract above | no |
| `workhorse_list_chats` | chats, compact by default (`id`, `title`, `worker`, `parentId`, `status`, `next`, `project`). `parents` omits workers. `full` adds preview and sidebar | no |
| `workhorse_read_chat` | one chat's transcript | no |
| `workhorse_query_capacity` | leftover and callability per bot; advisory | no |
| `workhorse_delegate` | run one task through Workhorse as a worker; Workhorse picks the worker | yes |
| `workhorse_continue_mission` | follow up: continue the wave a worker finished with only the remaining work; Workhorse routes the next pass | yes |
| `workhorse_agent_status` | follow through: `next` is wait, done, or failed; report when done | no |
| `workhorse_ask_chat` | a message to a live chat | yes |
| `workhorse_local_hosts` | configured local inference hosts, without credentials | no |
| `workhorse_local_capabilities` | typed capability and model-profile discovery | no |
| `workhorse_local_upload` | upload a base64 artifact with type and provenance | yes |
| `workhorse_local_chat` | upload a prompt artifact and submit local text generation | yes |
| `workhorse_local_generate_3d` | submit image-to-3D with GLB/report output requirements | yes |
| `workhorse_local_job` | validate current job state, artifacts and continuations | no |
| `workhorse_local_cancel` | request durable job cancellation | yes |
| `workhorse_local_artifact` | artifact type, size, SHA-256 and validation metadata | no |
| `workhorse_local_materialize` | byte-range download into Workhorse's SHA-verified cache | yes |
| `workhorse_local_continue` | dispatch one approved, allowlisted continuation as a visible worker | yes |

Not available through Link: credentials, permissions, deletes, renames,
custom-bot setup, Watch permits, project mutation. They are not listed and
a call is refused.

`workhorse_capabilities` and `tools/list` name the current versioned contract. Older names
(`workhorse_spawn_agent`, `workhorse_list_bots`, `workhorse_list_projects`,
`workhorse_list_agents`, `workhorse_list_external_agents`,
`workhorse_await_agents`, `workhorse_cancel_agent`) still answer so a harness
that already calls them is not refused. New harnesses should use the advertised contract.
When no local host is configured, discovery advertises only
`workhorse_local_hosts`; the remaining local execution tools appear after a
valid host configuration is present.

## Local capability hosts

Local inference machines are execution hosts, not Workhorse vendors or custom
bots. Configure one or more on the MCP helper process; the bearer token stays
in a mode-restricted file and is never returned by Link:

```json
{
  "WORKHORSE_LOCAL_HOSTS_JSON": "[{\"id\":\"dgx-spark\",\"baseUrl\":\"https://spark.example.ts.net/spark\",\"tokenFile\":\"/path/to/spark-token\"}]"
}
```

Hosts must use HTTPS; plain HTTP is accepted only on loopback. Requests and
results use protocol 1.0 with strict field validation, trace/idempotency keys,
route history and hop counts. Jobs are asynchronous. Large artifacts use the
broker's byte-range content route, then Workhorse verifies size and SHA-256
before an atomic cache commit.

The shipped 3D builder is image-to-3D. It returns GLB and validation artifacts
plus an optional Blender continuation. Authorization in the original request
does not silently run Blender: `workhorse_local_continue` separately validates
the exact allowlisted contract, claims it in the restart journal, stages the
verified GLB under the requested project folder, and creates one visible
Workhorse worker. A repeated idempotency key replays that worker.

When Settings → Learning is on, each Link call is stored on this machine as
agent evidence. Keys and chat text stay out.

## Follow through

The same loop for Claude, Codex, Grok, OpenClaw, and Hermes:

1. `workhorse_list_chats` — pick the parent chat. Default list is compact so a
   host 20–64 KB output cap does not clip it. Workers show `worker`, `parentId`,
   `status`, and `next` (so Marlow is findable by name). Pass `parents` for
   parent chats only, `full` for preview. If several rows share a worker name,
   pass that row's `id`.
2. New slice: `workhorse_delegate`. `fromSessionId` is that parent, never the
   worker. Stop this turn. The desk joins the report into the parent chat.
   Named worker: `workhorse_ask_chat` with that row's `id`.
3. Later, `workhorse_agent_status` with the worker id. `next` is `wait`,
   `done`, or `failed`. When `done`, the report is in that payload.
4. Remaining work: `workhorse_continue_mission`. Read: `workhorse_read_chat`.

Do not sit in a poll loop in the same turn. Do not spawn a second worker for
the same slice. Do not pass `wait=true`; Link ignores it so the client is not
blocked. A later process may call `workhorse_agent_status` until `next` is
`done` or `failed`; that is monitoring, not a same-turn poll.

A desk `/goal` or `/loop` is still the composer. Link assigns the objective as
a mission: `workhorse_delegate` with `loop.acceptanceCriteria`. Remaining work
is `workhorse_continue_mission`.

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
workhorse chats
workhorse chats --parents
workhorse chats --full
workhorse read <sessionId>
workhorse ask --chat <sessionId> --message "Review this change" --key <idempotencyKey>
workhorse delegate --chat <sessionId> --task "Review this change" --key <idempotencyKey>
workhorse delegate --chat <sessionId> --task "Ship and certify" --accept "Tests pass" --accept "Marker file exists" --passes 2 --folder <dir>
workhorse status <workerId>
workhorse follow-up <workerId> "Check the failing test" --chat <sessionId> --key <idempotencyKey>
workhorse local-hosts
workhorse local-capabilities --host dgx-spark
workhorse local-upload source.png --kind image --role source_image --media-type image/png --host dgx-spark
workhorse local-chat "Return ROUTER_OK" --host dgx-spark --key chat-1
workhorse local-3d <sourceArtifactId> --host dgx-spark --max-faces 100000 --target-engine godot --approve-blender --key model-1
workhorse local-job <jobId> --host dgx-spark
workhorse local-materialize <artifactId> --host dgx-spark
workhorse local-continue <jobId> <continuationId> --host dgx-spark --chat <sessionId> --folder <projectPath> --key blender-1
```

`local-upload` accepts one file up to 64 MiB; for larger transfers use the
broker CLI directly. Raw protocol submission is not exposed by Link or its
CLI. All
local subcommands call the same Link tool handler used by MCP.

When 3D generation returns a valid but over-budget or non-watertight mesh,
Link exposes it only as an explicitly authorized intermediate. The artifact
and JSON report include `faceLimitSatisfied`, `watertightSatisfied`, and
`requiresPreparation`; the typed continuation then dispatches Blender to
produce the required game GLB, PNG preview, and JSON report.

Without the command, the same calls are
`"<binary>" "<workhorse-mcp.js>" link …` with the three environment variables
from the MCP config set. Output is JSON on stdout; exit 1 with `{"error": …}`
on failure.

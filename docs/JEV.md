# Jev as a Workhorse tool

TypeSafe Jev is a structured evaluator, not a chat model. The first-party
`scripts/jev-mcp.mjs` server exposes one MCP tool, `jev_evaluate`, to runtimes
you choose in Workhorse Settings → Skills. It sends `state` and named `questions`
to TypeSafe's direct `POST /v1/systemone` endpoint using `jev-latest`. It does
not expose the credential to a model, give Jev filesystem or shell access, or
let a caller choose another URL or model. The response includes answers and
TypeSafe's per-call input/output token usage.

## Set up

1. Obtain a TypeSafe API key from [TypeSafe's console](https://console.typesafe.ai/keys).
2. In Workhorse Settings → Skills → Add server, enter a name such as `jev`,
   command `node` (or the absolute path to Node), and the absolute path to
   `scripts/jev-mcp.mjs` as the sole argument.
3. Add `TYPESAFE_API_KEY=<key>` in Environment. Workhorse moves this value to
   its OS-encrypted credential store when saved. On macOS, this installation
   also supports a local Keychain item with service `go7.typesafe.jev` and
   account `workhorse-jev`, so the field may be left empty if that item exists.
4. Select only the runtimes that should be able to send data to TypeSafe.
   This server has one tool, so “Use every tool this server reports” is safe
   as a tool allowlist; the runtime allowlist is still important. Save, then
   use Test to confirm `jev_evaluate` is discovered.

For a bounded experiment, set `JEV_MCP_MAX_CALLS` to a positive integer in
that server's Environment. The bridge refuses additional calls after that
many valid attempts in the **current server process**, including attempts
whose response failed or was lost. Invalid inputs do not use the allowance.
This is a per-process guard, not a durable mission-wide budget: a new process
starts a new allowance. Leave the variable unset for ordinary use. Do not
entrust a multi-turn or multi-worker spending ceiling to a model's own count.

Example tool input:

```json
{
  "state": "The invoice must be paid today.",
  "questions": {
    "urgent": {
      "type": "noul",
      "instructions": "Does this explicitly contain a deadline?"
    }
  }
}
```

`noul` returns a yes-probability. `choice` needs a map of 2–12 options;
`score` needs 2–10 ordered rubric levels. The bridge accepts 1–12 questions
and a maximum 32 KB serialized request. These are safety and spending bounds,
not TypeSafe API limits. A model should send only information the user intends
to share with TypeSafe. Jev's answer is evidence to consider, not permission to
act or proof that a report is true.

This does **not** switch Workhorse's separate mission Judge (Settings → Routing)
from its existing Vercel AI Gateway bot. The MCP tool is available for explicit
evaluation tasks by the selected models. Nor does it create a provider Usage
ring or claim a remaining balance: TypeSafe documents per-request token usage,
but no machine-readable prepaid balance endpoint for this integration.

API reference: [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart),
[TypeSafe API reference](https://docs.typesafe.ai/api).

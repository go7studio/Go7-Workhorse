---
name: dgx-spark
description: >
  Connect one or more NVIDIA DGX Spark boxes as callable Workhorse bots.
  Collects model delivery from the Spark gateway (/v1/models), stores the
  owner bearer in a local token file, and registers Qwen (and any other
  advertised model) through Add bot / workhorse_setup_custom_bot. Use when
  the user says add Spark, DGX Spark, call Qwen, Spark login, NVIDIA Sync,
  collect models from the box, or runs /dgx-spark.
---

# DGX Spark (call models)

NVIDIA Sync is SSH. The Spark gateway stays loopback-only on the box
(`127.0.0.1:8788`). This desk talks to it through a local forward, then
collects `/v1/models` and creates a custom bot. It is not a stock vendor.

Train/infer fence on the box itself is a different skill
(`nvidia-spark-train-infer`). This skill only connects a desk so it can *call*
what the box is already serving.

## Inputs

Set these before collecting. Never put the bearer, SSH password, or Tailscale
auth key in git, chat, or this file.

| Env / flag | Meaning |
|---|---|
| `DGX_SPARK_SSH` | `user@host` or `user@192.168.1.205` (repeat per box) |
| `DGX_SPARK_ID` | Short id for a second box (`spark-2`). Default `spark`. |
| `DGX_SPARK_LOCAL_PORT` | Local listen port. Default `8788`. |
| `DGX_SPARK_TOKEN_FILE` | Absolute path for the copied owner bearer |

Default token file: `~/.config/go7-inference/client-keys/<id>`.

Remote token (on the Spark, do not change unless the operator moved it):
`~/.config/go7-inference/client-keys/owner`.

## Workflow

1. **Key.** If this machine has no SSH key, generate one (`ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_spark -N ""`). Print the **public** key only. Stop until that key is in the Spark account's `authorized_keys` (NVIDIA Sync may install its own key — if login still asks for a password, it is a different key than the one on this desk).
2. **Forward.** `ssh -N -L <local>:127.0.0.1:8788 <user@host>`. NVIDIA Sync is the same tunnel. Fail if port 22 is closed or BatchMode is denied.
3. **Collect the bearer.** `scp <user@host>:~/.config/go7-inference/client-keys/owner <token-file>`. Restrict the local file (Windows ACL / Unix `0600`). Never print it. Never write it into Workhorse state by hand.
4. **Collect models.** `GET http://127.0.0.1:<local>/v1/models` with `Authorization: Bearer` from the file. List ids only. A missing catalog is not a dead host — say so and keep the typed model id.
5. **Desk bot.** `workhorse_list_bots`. If Qwen (or the id the catalog returned) is already there, tell the user to pick it under This chat → Vendor. Otherwise `workhorse_setup_custom_bot` with:
   - `name`: the Spark id or "DGX Spark"
   - `baseUrl`: `http://127.0.0.1:<local>/v1`
   - `model`: catalog id, else `qwen3.8-27b`
   - `apiKey`: contents of the token file (do not echo)
   - `api`: `openai-completions`
6. **Local Compute (optional).** Settings → LLMs → Add host. Address `http://127.0.0.1:<local>` (no `/v1`), token-file path from step 3. Recheck lists `/v1/models` again. Grant callers/capabilities only after it is healthy. Workshop packs read through this host; chat still goes through the bot from step 5.
7. **Call.** New chat → Vendor = that bot. Qwen 3.8 uses Off / Low / Medium / Extra. Fail closed if the tunnel or shim is down.

Use `skills/dgx-spark/scripts/collect-delivery.ps1` for steps 2–4 on Windows. It prints model ids and the token-file path, never the bearer.

## Several Sparks

One tunnel, one token file, one bot per box. Distinct `DGX_SPARK_ID` and local ports (`8788`, `8789`, …). Do not reuse a token file across hosts.

## Do not

- Expose the gateway on the LAN. Owner bearer stays on-box.
- Paste the Spark Linux password through Telegram, git, or chat.
- Treat Spark as Grok, Codex, Claude, or Cursor.
- Start, stop, or park training from this skill (`nvidia-spark-train-infer` owns that fence).
- Invent a Tailscale or HTTPS URL. If the operator already published one, use it as `baseUrl` instead of the loopback forward.

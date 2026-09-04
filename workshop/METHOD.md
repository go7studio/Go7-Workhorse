# Workshop v0 method

Separate add-on. Default off. Read-only.

## Desk

1. Open Workhorse Settings, then Skills, then Workshop.
2. Turn on Box monitor and confirm the listed read grants (install/grant only).
3. Live watch appears on the desk Workshop rail (collapsed strip → expand). Optional Detach opens the breakout window. No new Settings tab. No dock item.
4. Add a Local Compute host under Settings, LLMs, so infer and feed GETs can reuse that bearer.
5. Infer tiles soak healthz, readyz, and v1/models now. GPU and train tiles stay unknown until the Spark feed GET is allowlisted and present.
6. Turn off unloads host modules. It does not uninstall the Spark feed.
7. Models + Router cards are soak labels only — no routing, lease, start, or stop.

## Spark (NVIDIA Sync terminal, operator only)

Copy workshop-feed.py and the two systemd units from workshop/packs/box-monitor/spark-feed/ onto the Spark as the operator. Enable the user timer. Prove a local snapshot exists. The desk never installs this.

Failed collector runs must leave the last valid feed.json in place.

### How the collector reads the job

Nothing talks to NVIDIA Sync. Four sources, in this order:

| Source | Path / command | Feed field |
| --- | --- | --- |
| Lease | `~/workloads/creative-llm/ACTIVE_GPU_JOB.json` | `job.lease` — kind, pid, yaml, startedUtc, and `pidMatch` against `pgrep -f train_pretrain.py` |
| Live log | newest `~/workloads/creative-llm/logs/exclusive-probes/*.log`, `\r` → `\n` | `job.live` — last `[step]` line, and `last8TokS` = Δtokens / Δelapsed over the last 480 s of step lines (first 60 s skipped) |
| Durable | newest `checkpoints/**/latest.json` | `job.durable` — step, tokens_seen, target_tokens, tokens_per_step, param_count, losses, `job_complete`, `undertrained_flag`, run_name, savedAt (mtime) |
| Box | `nvidia-smi` name / utilization / power | `gpuUtilPercent`, `powerWatts`, `job.gpuName`. UMA memory is N/A and never invented |
| Fence | `systemctl --user is-active` on the probe unit, `qwen38-sglang`, `bloom-v40-500m` | `exclusiveSidecar`, `job.fence` |

Never published: the sidecar's whole-run tok/s and `latest.json` `tokens_per_sec` (both include compile). `max_steps` is not an ETA input. The collector publishes pct, remain, hours to the floor, s/it, and steps-ahead as `job.derived`; the desk formats them, and for a feed without `derived` computes the same formulas from the raw fields (`deriveJob`). The desk paints `job_complete` / `undertrained_flag` as the trainer wrote them.

Gateway reads are GET only, on the configured host's origin, without following redirects, with a streamed 256 KiB cap (`gatewayUrl`, `readCapped`). The pack contract that generalises this is `PACKS.md`.

`job.flags` are the four abort signals: `two-trainers`, `qwen-up-during-train`, `gpu-idle` (0 % for 3 min with a trainer present), `step-backwards` (durable step below the previous feed's). They are labels on the rail; the desk does nothing about them.

Cadence: the timer runs every 30 s, which covers nvidia-smi (5–15 s wanted, 30 s accepted), the log (20–60 s), latest.json (60 s), and lease + systemd (30–60 s) in one pass. The desk polls the feed every 2 s and the feed is considered stale after 2 min.

## IPC (automation)

| Call | Does | Does not |
| --- | --- | --- |
| Renderer `updateWorkshop` (via Settings → Skills) | Turns packs On/Off and sets grants | Open/close breakout by itself |
| `workshopOpenBreakout` / `workshopCloseBreakout` | Opens or closes the breakout window | Flip pack on/off |
| `workshopOptin` (`workshop:optin`) | Opens breakout **only if** a pack is already On | Opt a pack in or grant reads |
| `workshopRevoke` (`workshop:revoke`) | Closes breakout **only if** no pack remains On | Turn a pack off or clear grants |

Automation must not treat optin/revoke as pack toggles. Pack state is `settings.workshop` only.

## Soak labels (Box monitor breakout)

Models and Router cards are soak-only labels: loaded model ids (or `infer down (train exclusive)`), train fence / Local Compute invoke, probeUnit, qwen parked/up. They never change Settings → Routing, start/stop jobs, or hold leases.


## Desk rail (2026-09-04)

Live watch = desk Workshop rail (collapsed strip → expand; multi-pack stack). Skills = install/grant only. Breakout = optional detach. See RAIL.md.

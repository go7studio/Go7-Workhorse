# Workshop v0 method

Separate add-on. Default off. Read-only.

## Desk

1. Add a Local Compute host under Settings → LLMs. Every pack read is a GET through one of these hosts with that host's bearer; Workhorse adds no other credential.
2. Open Settings → Skills → Workshop. Paste a public GitHub repo URL and press Add (the highest tagged release is downloaded, staged, validated, then installed), or press From folder to copy a pack folder. No `git` binary. A pack outside the vocabulary is refused with the exact field or "needs a newer Workhorse".
3. Press Turn on. Pick the host the pack reads through. The panel lists each source with its kind, cadence, byte cap, and the exact URLs the host will build. Untick what you do not want. Confirm stores `{ id, on, hostId, sources, version, contract }` under `settings.workshop`.
4. Live watch appears on the desk Workshop rail (collapsed strip → expand). Optional Detach opens the breakout window. No new Settings tab. No dock item.
5. Update re-reads the repo's tags. When sources, host needs, cadence, byte caps, or contract changed, the pack turns off and asks you to Turn on again. Card-only changes apply with a version note.
6. Turn off clears `sources` and stops the reads. Remove deletes the pack folder and its row. Neither touches the remote box.
7. A pack's `collector/` is shown and revealed in the file manager only. Workhorse never runs, chmods, or copies it anywhere.
8. Every card is a label. Nothing on the rail starts, stops, routes, or leases anything.

## Spark (NVIDIA Sync terminal, operator only) (moves to the pack repo)

Copy `workshop-feed.py` and the two systemd units from the pack repo
(`packs/box-monitor/collector/`) onto the Spark as the operator into
`~/.local/bin/` and `~/.config/systemd/user/`. Enable the user timer. Prove a
local snapshot exists with `job.live` / `job.derived`. The desk never installs
this. Gateway route for the feed is `/workshop/v0/feed` (not
`/workshop/box-monitor/feed`). Packs declare `namespace: "v0"`.

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
| Renderer `updateWorkshop` (via Settings → Skills) | Turns packs on or off and sets `hostId` and `sources` | Open or close the breakout by itself |
| `workshopList` (`workshop:list`) | Lists installed packs with sources, provenance, and grant state | Fetch anything from a host |
| `workshopView` (`workshop:view`) | Returns the packs that are on with layout and main's cached documents | Start a timer; main owns the polling |
| `workshopInstallRepo` (`workshop:install-repo`) | Downloads the highest tagged release of a public https repo, stages, validates, installs | Run `git`, follow redirects, or accept a private repo |
| `workshopInstallFolder` (`workshop:install-folder`) | Opens the folder picker and copies the pack in | Reference the folder in place |
| `workshopRemove` (`workshop:remove`) | Deletes the pack folder | Drop the settings row; the renderer rewrites it |
| `workshopCheckUpdate` (`workshop:check-update`) | Reads the repo's tags and returns current and latest | Change anything on disk |
| `workshopUpdate` (`workshop:update`) | Re-installs the latest tag; sets `reconfirm` and turns the pack off when sources changed | Widen a grant or keep an old grant against new URLs |
| `workshopRevealCollector` (`workshop:reveal-collector`) | Shows the collector folder in the OS file manager | Run, chmod, or copy anything in it |
| `workshopOpenBreakout` / `workshopCloseBreakout` (`workshop:open-breakout` / `workshop:close-breakout`) | Opens or closes the breakout window | Flip a pack on or off |

Pack state is `settings.workshop` only. No channel starts, stops, routes, or leases anything on the box.

## Soak labels (Box monitor breakout)

Models and Router cards are soak-only labels: loaded model ids (or `infer down (train exclusive)`), train fence / Local Compute invoke, probeUnit, qwen parked/up. They never change Settings → Routing, start/stop jobs, or hold leases.


## Desk rail (2026-09-04)

Live watch = desk Workshop rail (collapsed strip → expand; multi-pack stack). Skills = install/grant only. Breakout = optional detach. See RAIL.md.

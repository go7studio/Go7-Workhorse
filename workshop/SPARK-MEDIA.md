# Workshop pack: Spark media (Comfy) — locked 2026-09-04

Steve: usable ComfyUI modular add-on on Workhorse. Not a Settings page. Stacks on the Workshop rail next to Box monitor.

## Must-ship features (v0)

### 1. Outputs — display / deliver / watch
User can see what Spark made without opening a raw Comfy browser tab as the only path.

- Live **queue + progress** (prompt id, %, ETA when known)
- **Gallery** of recent outputs (stills + video thumbs)
- **Open / reveal / copy path** for a selected artifact
- **Watch / play** video in-panel or detach (desk media viewer)
- Deliver into Workhorse as a **local artifact** (same Local Compute artifact lane as Flux jobs) so chats/agents can attach later

### 2. Creation — modify / change / direct on device
User can steer generation on Spark from the desk.

- Pick a **workflow template** (Flux still, Empire Tycoon LoRA, MiniMax H3 t2v/i2v when installed)
- Edit **prompt / seed / size / duration / LoRA** fields exposed by the template (not a full node graph editor in v0)
- **Queue / cancel** job via Local Compute → Spark Comfy API (Electron main owns HTTP; renderer never SSH)
- Respect **train fence**: refuse create while exclusive Bloom soak owns the GPU (plain words + Box monitor link). No silent queue into a clobbered writer.

## Bonus (v0.5)

### Tag for Workhorse ingest
Mark a crop / clip / frame / full artifact as usable by desk models:

- Tags: e.g. `ref-image`, `character-lora-source`, `style-still`, `motion-ref`, `audio-bed`
- Stored as sidecar JSON next to artifact + listed in pack UI
- Later: agents / Local Compute can **ingest** tagged items into prompts, LoRA datasets, or chat attachments
- v0.5 = tag + list + copy-into-chat; full auto-ingest pipeline later

## Surfaces

| Surface | Role |
| --- | --- |
| Settings → Skills → Workshop | Install / grant for pack `spark-media` only |
| Desk Workshop **rail** module | Primary: collapsed = queue/last output; expand = gallery + create form |
| Optional breakout | Detach gallery / create for big preview |
| Comfy web UI on Spark | Advanced escape hatch (open link) — not the only UX |

## Privilege split (Workshop law)

- Manifest grants (v0 draft):
  - `read.comfy.queue` — queue + history thumbs
  - `read.comfy.outputs` — list / preview artifacts
  - `invoke.comfy.job` — queue / cancel templates via Local Compute
  - (bonus) `write.comfy.tags` — tag sidecar
- Electron **main** owns Tailscale/Local Compute bearer GETs/POSTs
- Renderer paints only
- **Never:** SSH from renderer, Bloom start/stop, flip Settings→Routing, leftover UsageEvents for GPU watts

Banned control-plane grants stay banned (`job.start` Bloom, `ssh.`, `routing.`, `lease.`). Comfy create is **template invoke** through Local Compute, not a fourth GPU lease broker.

## Spark side (ops, after Bloom)

1. Spark-tuned ComfyUI (existing Flux / Empire LoRA path)
2. MiniMax H3 Comfy weights + workflow templates when disk + fence allow
3. Publish: Comfy API (loopback or allowlisted Serve path) + output dir the desk can materialize via Local Compute artifacts
4. Health: Comfy `/system_stats` or equivalent for rail “Comfy up”

## Out of scope v0

- Full Comfy node editor in Workhorse
- fal H3 Max inside the pack (cloud; separate)
- Auto-training LoRAs from tags
- Running create during exclusive train

## Success

Steve opens Workshop rail → Spark media On → sees last Flux/H3 outputs, plays a clip, changes prompt, queues a gen on Spark, gets the file back on the desk. Tags are optional polish after that works.

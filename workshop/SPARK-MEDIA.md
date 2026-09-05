# Workshop pack: Spark media (Comfy) — locked 2026-09-04 (amended)

Steve: usable ComfyUI modular add-on on Workhorse. Stacks on the Workshop rail.
Amended same day to match Workshop host law (`PACKS.md` + `workshop-never`): packs are
**data only**; Workhorse ships **no** `workshop/packs/`; workshop host/UI source must
not embed box vendor words; workshop HTTP is **GET only**.

## Must-ship features (v0)

### 1. Outputs — display / deliver / watch
- Live **queue + progress** from a media feed (prompt id, %, ETA when known)
- **Gallery** of recent outputs (stills + video) via a new host widget `gallery`
- **Open / reveal / copy path** for a selected artifact (desk-local IPC; not box control)
- **Play** video in desk media viewer when path is local
- Deliver into Workhorse as a **Local Compute artifact** (same lane as Flux jobs)

### 2. Creation — modify / change / direct on device
- Template picker + edit prompt/seed/size/duration/LoRA fields from **feed-published
  templates** (Flux first; Empire LoRA / MiniMax H3 when installed on Spark)
- **Queue / cancel** via **Local Compute** capability invoke (Electron main owns HTTP;
  renderer never SSH; workshop-host stays GET-only)
- **Refuse create** while exclusive train fence owns the GPU: collector publishes
  `create.allowed=false` + plain-words `create.refuseReason`; rail paints that —
  no silent queue into a clobbered writer

## Surfaces

| Surface | Role |
| --- | --- |
| Pack repo `workshop-pack-spark-media` | `packs/spark-media/pack.json` + collector notes — **not** bundled in Go7-Workhorse |
| Settings → Skills → Workshop | Install / grant pack (folder or tag archive) |
| Desk Workshop **rail** module | Primary: collapsed = queue/last output; expand = gallery + create form |
| Optional breakout | Detach gallery / create |
| Comfy web UI on Spark | Advanced escape hatch link from feed — not the only UX |

## Privilege split

- Workshop grants stay host kinds: `read.json` / `read.probes` on a Local Compute host
- Create is **Local Compute capability invoke** (`comfy.flux` etc. advertised by Spark),
  not a workshop POST and not a pack action widget
- Host may add closed widgets: `gallery` (items from feed). Desk actions open/reveal/copy
  are host IPC on local paths only
- **Never:** SSH from renderer, Bloom start/stop from Workshop, leftover UsageEvents for GPU,
  `workshop/packs` inside Go7-Workhorse, vendor words inside workshop host/UI sources

## Feed shape (collector on Spark — `go7-workshop-media/v0`)

Published under gateway `/workshop/media/feed` (namespace `media`, path `feed`):

```json
{
  "schema": "go7-workshop-media/v0",
  "asOf": "ISO-8601",
  "queue": { "active": 0, "pending": 0, "promptId": null, "progressPct": null, "etaSec": null },
  "outputs": [{ "id": "", "kind": "image|video", "label": "", "path": "", "thumbPath": "", "mtime": "" }],
  "create": {
    "allowed": true,
    "refuseReason": "",
    "templates": [{ "id": "flux-still", "capability": "comfy.flux", "label": "Flux still", "fields": ["prompt","seed","width","height"] }]
  },
  "comfyUp": true
}
```

When Bloom exclusive fence is up, collector sets `create.allowed=false` and
`refuseReason` to plain words (e.g. `infer down / train exclusive — create paused`).

## Bonus (v0.5)

Tag artifacts (`ref-image`, `character-lora-source`, …) as sidecar JSON + list in UI.
Full auto-ingest later.

## Out of scope v0

Full Comfy node editor; fal H3 Max cloud; auto-train LoRAs from tags; create during exclusive train.

## Success

Steve installs spark-media pack → rail shows queue/last output → expand plays a clip /
changes prompt → queues a gen via Local Compute → file lands as desk artifact. Create
refuses in plain words under Bloom fence.

# Local media create (desk)

Workshop packs may publish `create.templates` on a media feed. The desk paints a
host-owned create form (`MediaCreatePanel`) and queues through Local Compute —
never through `workshop-host` (GET only).

## Capability pattern

Image/video templates use Local Compute capability ids such as:

| Id | Intent |
| --- | --- |
| `comfy.flux` | Flux still (first) |
| `comfy.video` | Video template when advertised |

The collector on the box advertises templates with a `capability` field. The desk
calls `localMediaCreate` which gates on `host.allowedCapabilities` (same empty-caps
wording as the Workshop strip: **Local Compute host has no allowed capabilities**).

## Invoke path

- Module: `electron/local-media-create.ts`
- IPC: `localMedia:create` (preload `localMediaCreate`)
- Submit: `LocalCapabilityHostClient.submit` → `POST /v1/jobs` when the host token
  and capability grant allow it
- Refuse: missing host, empty allowed capabilities, capability not granted, or LC error

Spark may not advertise live Comfy capabilities yet. Until the box lists
`comfy.flux` and the user grants it under Settings → Local Compute, Queue shows
the empty-caps / not-callable message instead of inventing a remote start.

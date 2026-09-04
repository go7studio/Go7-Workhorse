# Workshop v0 method

Separate add-on. Default off. Read-only.

## Desk

1. Open Workhorse Settings, then Skills, then Workshop.
2. Turn on Box monitor and confirm the listed read grants.
3. A Workshop breakout window opens. No new Settings tab. No dock item.
4. Add a Local Compute host under Settings, LLMs, so infer and feed GETs can reuse that bearer.
5. Infer tiles soak healthz, readyz, and v1/models now. GPU and train tiles stay unknown until the Spark feed GET is allowlisted and present.
6. Turn off unloads host modules. It does not uninstall the Spark feed.
7. Models + Router cards are soak labels only — no routing, lease, start, or stop.

## Spark (NVIDIA Sync terminal, operator only)

Copy workshop-feed.py and the two systemd units from workshop/packs/box-monitor/spark-feed/ onto the Spark as the operator. Enable the user timer. Prove a local snapshot exists. The desk never installs this.

Failed collector runs must leave the last valid feed.json in place.

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

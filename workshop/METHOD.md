# Workshop v0 method

Separate add-on. Default off. Read-only.

## Desk

1. Open Workhorse Settings, then Skills, then Workshop.
2. Turn on Box monitor and confirm the listed read grants.
3. A Workshop breakout window opens. No new Settings tab. No dock item.
4. Add a Local Compute host under Settings, LLMs, so infer and feed GETs can reuse that bearer.
5. Infer tiles soak healthz, readyz, and v1/models now. GPU and train tiles stay unknown until the Spark feed GET is allowlisted and present.
6. Turn off unloads host modules. It does not uninstall the Spark feed.

## Spark (NVIDIA Sync terminal, operator only)

Copy workshop-feed.py and the two systemd units from workshop/packs/box-monitor/spark-feed/ onto the Spark as the operator. Enable the user timer. Prove a local snapshot exists. The desk never installs this.

Failed collector runs must leave the last valid feed.json in place.

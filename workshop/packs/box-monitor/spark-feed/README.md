# box-monitor Spark feed

Install on Spark only, from an NVIDIA Sync terminal. The Workhorse desk does not install this.

The collector writes ~/.local/share/go7-workshop/feed.json every 30s. Failed refreshes keep the last valid file. trainNameMatchCount is a name-match count, not a process list to stop.

It reads the lease file, the exclusive log tail, the newest latest.json, nvidia-smi, and the probe and fence units. The `job` section carries live step and last-8 rate, the durable save, the lease, fence state, and the four abort flags. `GO7_WORKSHOP_WORKLOAD` overrides `~/workloads/creative-llm`.

See workshop/METHOD.md.

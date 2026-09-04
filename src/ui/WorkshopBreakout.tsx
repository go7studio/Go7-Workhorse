import {
  WORKSHOP_UNKNOWN,
  feedAgeLabel,
  paintJobStatus,
  paintModelsLine,
  paintQwenParked,
} from "../lib/workshop";
import { dash, useWorkshopLive } from "./workshop-live";

export function WorkshopBreakout() {
  const { packs, metrics, tail, feed } = useWorkshopLive();
  const on = packs.filter((pack) => pack.on);
  const off = packs.filter((pack) => !pack.on && !pack.refused);
  const labels = metrics?.labels ?? { trainFence: "nvidia-spark-train-infer", inferInvoke: "Local Compute" };
  const feedLine =
    feed.present && feed.asOf ? `${feed.note} ${feedAgeLabel(feed.asOf)}` : feed.note;

  return (
    <section className="workshop-breakout settings">
      <div className="link-head">
        <div>
          <strong>Workshop{on[0] ? " · " + on.map((pack) => pack.name).join(" · ") : ""}</strong>
          <p className="row-meta">Separate add-on · read-only · Spark feed optional · detach from desk rail</p>
        </div>
        <div className="actions">
          <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopCloseBreakout?.()}>Close</button>
        </div>
      </div>

      {on.length === 0 ? (
        <p className="row-meta">
          {off.length
            ? off.map((pack) => pack.name + " — off").join(" · ") + ". Turn a pack on from Settings → Skills → Workshop."
            : "Off until you add a pack. Add a pack from Settings → Skills → Workshop. Packs are read-only. They do not start jobs."}
        </p>
      ) : null}

      {on.some((pack) => pack.id === "box-monitor") ? (
        <>
          <div className="workshop-card">
            <div className="section-label">Box</div>
            <Meter label="GPU %" value={dash(metrics?.gpuUtilPercent)} />
            <Meter label="Watts" value={dash(metrics?.powerWatts)} />
            <Meter label="Writer" value={dash(metrics?.oneWriter)} />
            <Meter label="tok/param" value={dash(metrics?.tokPerParam)} />
          </div>
          <div className="workshop-card">
            <div className="section-label">Models</div>
            <Meter label="Loaded" value={paintModelsLine(metrics)} />
          </div>
          <div className="workshop-card">
            <div className="section-label">Infer</div>
            {(metrics?.infer ?? []).map((tile) => (
              <Meter
                key={tile.path}
                label={tile.path}
                value={tile.status === "unauthorized" ? "unauthorized" : tile.status === "ok" ? "up" : WORKSHOP_UNKNOWN}
              />
            ))}
          </div>
          <div className="workshop-card">
            <div className="section-label">Router</div>
            <Meter label="Train fence" value={labels.trainFence} />
            <Meter label="Infer invoke" value={labels.inferInvoke} />
            <Meter label="probeUnit" value={dash(metrics?.exclusiveSidecar?.probeUnit)} />
            <Meter label="qwen" value={paintQwenParked(metrics?.exclusiveSidecar?.qwenParked ?? WORKSHOP_UNKNOWN)} />
            <p className="row-meta">labels only, never route/lease/start/stop</p>
          </div>
          <div className="workshop-card">
            <div className="section-label">Job this pack watches</div>
            <Meter label="Name" value="Bloom soak" />
            <Meter label="Role" value="first job, not the product name" />
            <Meter label="Status" value={paintJobStatus(metrics, feed.present)} />
            <Meter label="last-8" value={dash(metrics?.last8Toks)} />
            <Meter label="latest.json" value={dash(metrics?.latestJson)} />
          </div>
          <div className="workshop-card">
            <div className="section-label">Feed</div>
            <p className="row-meta">{feedLine}</p>
          </div>
        </>
      ) : null}

      {on.some((pack) => pack.id === "job-log") ? (
        <div className="workshop-card">
          <div className="section-label">Job log</div>
          <pre className="workshop-log">{tail}</pre>
        </div>
      ) : null}

      <p className="row-meta">
        NVIDIA Sync and DGX Dashboard stay NVIDIA UI. This panel does not start or stop the job. Feed may label models; it does not route or lease.
      </p>
    </section>
  );
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <div className="workshop-meter">
      <span>{label}</span>
      <span className="workshop-track" />
      <strong>{value}</strong>
    </div>
  );
}

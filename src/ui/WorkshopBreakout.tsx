import { useEffect, useState } from "react";
import {
  WORKSHOP_UNKNOWN,
  paintJobStatus,
  paintModelsLine,
  paintQwenParked,
  type WorkshopMetricsSnapshot,
  type WorkshopPackListing,
} from "../lib/workshop";

type JobTail = { tail: string };

function dash(value: unknown): string {
  if (value === WORKSHOP_UNKNOWN || value === undefined || value === null) return WORKSHOP_UNKNOWN;
  if (value === true) return "one";
  if (value === false) return "no";
  return String(value);
}

export function WorkshopBreakout() {
  const [packs, setPacks] = useState<WorkshopPackListing[]>([]);
  const [metrics, setMetrics] = useState<WorkshopMetricsSnapshot | null>(null);
  const [tail, setTail] = useState<string>(WORKSHOP_UNKNOWN);
  const [feedPresent, setFeedPresent] = useState(false);
  const [feedNote, setFeedNote] = useState("Feed not present. Every meter is " + WORKSHOP_UNKNOWN + ".");

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      const list = await window.workhorse?.workshopList?.();
      if (!live || !list) return;
      setPacks(list);
      const box = list.find((pack) => pack.id === "box-monitor" && pack.on);
      const job = list.find((pack) => pack.id === "job-log" && pack.on);
      if (box) {
        const snap = await window.workhorse?.workshopRead?.({ id: "box-monitor", grant: "read.box.metrics" });
        if (live && snap && typeof snap === "object" && !("unknown" in snap) && !("tail" in snap)) {
          setMetrics(snap as WorkshopMetricsSnapshot);
        }
        const side = await window.workhorse?.workshopRead?.({ id: "box-monitor", grant: "read.fs.sidecar" });
        // Sidecar grant fills exclusiveSidecar/latestJson only — never clobber live GPU/watts/writer with —.
        if (live && side && typeof side === "object" && !("unknown" in side) && !("tail" in side)) {
          const sideSnap = side as WorkshopMetricsSnapshot;
          setMetrics((current) => {
            if (!current) return sideSnap;
            return {
              ...current,
              exclusiveSidecar: sideSnap.exclusiveSidecar ?? current.exclusiveSidecar,
              latestJson: sideSnap.latestJson !== WORKSHOP_UNKNOWN && sideSnap.latestJson != null ? sideSnap.latestJson : current.latestJson,
            };
          });
        }
        const ports = await window.workhorse?.workshopRead?.({ id: "box-monitor", grant: "read.model.ports" });
        if (live && ports && typeof ports === "object" && !("unknown" in ports) && !("tail" in ports)) {
          const portSnap = ports as WorkshopMetricsSnapshot;
          setMetrics((current) => {
            if (!current) return portSnap;
            return {
              ...current,
              models: Array.isArray(portSnap.models) ? portSnap.models : current.models,
              infer: portSnap.infer?.length ? portSnap.infer : current.infer,
              localComputeEmptyCapabilities:
                portSnap.localComputeEmptyCapabilities !== WORKSHOP_UNKNOWN
                  ? portSnap.localComputeEmptyCapabilities
                  : current.localComputeEmptyCapabilities,
            };
          });
        }
        const status = await window.workhorse?.workshopFeedStatus?.({ id: "box-monitor" });
        if (live && status) {
          setFeedPresent(Boolean(status.present));
          setFeedNote(status.present ? "Feed present." : "Feed not present. Every meter is " + WORKSHOP_UNKNOWN + ". This desk does not remote-install.");
        }
      } else {
        setMetrics(null);
        setFeedPresent(false);
      }
      if (job) {
        const log = await window.workhorse?.workshopRead?.({ id: "job-log", grant: "read.job.log" }) as JobTail | { unknown: true } | undefined;
        if (live && log && !("unknown" in log)) setTail(log.tail);
      } else {
        setTail(WORKSHOP_UNKNOWN);
      }
    };
    void refresh();
    // Poll main liveSettings — breakout store can lag the desk save that opened us.
    const timer = window.setInterval(() => void refresh(), 2_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const stop = window.workhorse?.onWorkshopChanged?.(() => void refresh());
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      stop?.();
    };
  }, []);

  const on = packs.filter((pack) => pack.on);
  const off = packs.filter((pack) => !pack.on && !pack.refused);
  const labels = metrics?.labels ?? { trainFence: "nvidia-spark-train-infer", inferInvoke: "Local Compute" };

  return (
    <section className="workshop-breakout settings">
      <div className="link-head">
        <div>
          <strong>Workshop{on[0] ? " · " + on.map((pack) => pack.name).join(" · ") : ""}</strong>
          <p className="row-meta">Separate add-on · read-only · Spark feed optional</p>
        </div>
        <div className="actions">
          <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopCloseBreakout?.()}>Close</button>
        </div>
      </div>

      {on.length === 0 ? (
        <p className="row-meta">
          {off.length ? off.map((pack) => pack.name + " — off").join(" · ") + ". Turn a pack on from Settings → Skills → Workshop." : "Off until you add a pack. Add a pack from Settings → Skills → Workshop. Packs are read-only. They do not start jobs."}
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
              <Meter key={tile.path} label={tile.path} value={tile.status === "unauthorized" ? "unauthorized" : tile.status === "ok" ? "up" : WORKSHOP_UNKNOWN} />
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
            <Meter label="Status" value={paintJobStatus(metrics, feedPresent)} />
            <Meter label="last-8" value={dash(metrics?.last8Toks)} />
            <Meter label="latest.json" value={dash(metrics?.latestJson)} />
          </div>
          <div className="workshop-card">
            <div className="section-label">Feed</div>
            <p className="row-meta">{feedNote}</p>
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

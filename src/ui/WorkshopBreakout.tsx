import { useEffect, useState } from "react";
import { WORKSHOP_UNKNOWN, type WorkshopMetricsSnapshot, type WorkshopPackListing } from "../lib/workshop";
import { useStore } from "../lib/store";

type JobTail = { tail: string };

function dash(value: unknown): string {
  if (value === WORKSHOP_UNKNOWN || value === undefined || value === null) return WORKSHOP_UNKNOWN;
  if (value === true) return "one";
  if (value === false) return "no";
  return String(value);
}

export function WorkshopBreakout() {
  const store = useStore();
  const [packs, setPacks] = useState<WorkshopPackListing[]>([]);
  const [metrics, setMetrics] = useState<WorkshopMetricsSnapshot | null>(null);
  const [tail, setTail] = useState<string>(WORKSHOP_UNKNOWN);
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
        if (live && snap && typeof snap === "object" && !("unknown" in snap) && !("tail" in snap)) setMetrics(snap as WorkshopMetricsSnapshot);
        const side = await window.workhorse?.workshopRead?.({ id: "box-monitor", grant: "read.fs.sidecar" });
        if (live && side && typeof side === "object" && !("unknown" in side) && !("tail" in side)) {
          setMetrics((current) => current ? { ...current, ...(side as WorkshopMetricsSnapshot), infer: current.infer } : side as WorkshopMetricsSnapshot);
        }
        const status = await window.workhorse?.workshopFeedStatus?.({ id: "box-monitor" });
        if (live && status) {
          setFeedNote(status.present ? "Feed present." : "Feed not present. Every meter is " + WORKSHOP_UNKNOWN + ". This desk does not remote-install.");
        }
      } else {
        setMetrics(null);
      }
      if (job) {
        const log = await window.workhorse?.workshopRead?.({ id: "job-log", grant: "read.job.log" }) as JobTail | { unknown: true } | undefined;
        if (live && log && !("unknown" in log)) setTail(log.tail);
      } else {
        setTail(WORKSHOP_UNKNOWN);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [store.settings.workshop]);

  const on = packs.filter((pack) => pack.on);
  const off = packs.filter((pack) => !pack.on && !pack.refused);

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
            <div className="section-label">Infer</div>
            {(metrics?.infer ?? []).map((tile) => (
              <Meter key={tile.path} label={tile.path} value={tile.status === "unauthorized" ? "unauthorized" : tile.status === "ok" ? "up" : WORKSHOP_UNKNOWN} />
            ))}
            <p className="row-meta">Train fence · nvidia-spark-train-infer. Infer invoke · Local Compute.</p>
          </div>
          <div className="workshop-card">
            <div className="section-label">Job this pack watches</div>
            <Meter label="Name" value="Bloom soak" />
            <Meter label="Role" value="first job, not the product name" />
            <Meter label="Status" value={WORKSHOP_UNKNOWN} />
            <Meter label="last-8" value={WORKSHOP_UNKNOWN} />
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

import { useState } from "react";
import {
  WORKSHOP_UNKNOWN,
  feedAgeLabel,
  paintJobStatus,
  paintModelsLine,
  paintQwenParked,
  stripLine,
} from "../lib/workshop";
import { dash, useWorkshopLive } from "./workshop-live";

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <div className="workshop-meter">
      <span>{label}</span>
      <span className="workshop-track" />
      <strong>{value}</strong>
    </div>
  );
}

function GpuBar({ value }: { value: unknown }) {
  const pct = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  return (
    <div className="workshop-rail-gpu" aria-hidden={pct == null}>
      <div className="workshop-rail-gpu-fill" style={pct == null ? undefined : { width: `${pct}%` }} />
      <span>{pct == null ? WORKSHOP_UNKNOWN : `${pct}%`}</span>
    </div>
  );
}

function HealthChip({ path, status }: { path: string; status: string }) {
  const short = path.replace(/^\//, "");
  const tone = status === "ok" || status === "up" ? "ok" : status === "unauthorized" ? "warn" : "mute";
  return <span className={`workshop-chip workshop-chip-${tone}`}>{short} · {status}</span>;
}

/**
 * Desk-attached Workshop rail: live watch when any pack is On.
 * Settings → Skills stays install/grant only; breakout remains optional Detach.
 */
export function WorkshopRail() {
  const { packs, metrics, tail, feed } = useWorkshopLive();
  const [expanded, setExpanded] = useState(false);
  const on = packs.filter((pack) => pack.on);
  if (on.length === 0) return null;

  const boxOn = on.some((pack) => pack.id === "box-monitor");
  const jobOn = on.some((pack) => pack.id === "job-log");
  const labels = metrics?.labels ?? { trainFence: "nvidia-spark-train-infer", inferInvoke: "Local Compute" };
  const strip = boxOn ? stripLine(metrics) : jobOn ? "Job log" : "Workshop";
  const feedChip = feed.present
    ? feedAgeLabel(feed.asOf)
    : feed.note.startsWith("Feed present")
      ? "feed · present"
      : "feed · off";

  return (
    <aside
      className={`workshop-rail${expanded ? " is-expanded" : " is-collapsed"}`}
      aria-label="Workshop rail"
    >
      <div className="workshop-rail-head">
        <button
          className="tiny workshop-rail-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Collapse" : "Workshop"}
        </button>
        {expanded ? (
          <button
            className="tiny"
            type="button"
            onClick={() => void window.workhorse?.workshopOpenBreakout?.()}
          >
            Detach
          </button>
        ) : null}
      </div>

      {!expanded ? (
        <button
          className="workshop-rail-strip"
          type="button"
          title={strip}
          onClick={() => setExpanded(true)}
        >
          {boxOn ? (
            <>
              <span className="workshop-rail-kv">{typeof metrics?.gpuUtilPercent === "number" ? `${metrics.gpuUtilPercent}%` : WORKSHOP_UNKNOWN}</span>
              <span className="workshop-rail-kv">{typeof metrics?.powerWatts === "number" ? `${metrics.powerWatts}W` : WORKSHOP_UNKNOWN}</span>
              <span className="workshop-rail-kv">{metrics?.oneWriter === true ? "one" : metrics?.oneWriter === false ? "no" : WORKSHOP_UNKNOWN}</span>
              <span className="workshop-rail-kv workshop-rail-kv-models" title={paintModelsLine(metrics)}>{paintModelsLine(metrics)}</span>
              <span className="row-meta">{feedChip}</span>
            </>
          ) : null}
          {jobOn ? <span className="workshop-rail-kv">Job log</span> : null}
        </button>
      ) : (
        <div className="workshop-rail-body">
          {boxOn ? (
            <>
              <div className="workshop-card">
                <div className="section-label">Box</div>
                <Meter label="GPU %" value={dash(metrics?.gpuUtilPercent)} />
                <GpuBar value={metrics?.gpuUtilPercent} />
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
                <div className="workshop-chip-row">
                  {(metrics?.infer ?? []).map((tile) => (
                    <HealthChip
                      key={tile.path}
                      path={tile.path}
                      status={
                        tile.status === "unauthorized"
                          ? "unauthorized"
                          : tile.status === "ok"
                            ? "up"
                            : tile.status === "down"
                              ? "down"
                              : WORKSHOP_UNKNOWN
                      }
                    />
                  ))}
                </div>
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
                <Meter label="Status" value={paintJobStatus(metrics, feed.present)} />
                <Meter label="latest.json" value={dash(metrics?.latestJson)} />
              </div>
              <div className="workshop-card">
                <div className="section-label">Feed</div>
                <p className="row-meta">{feed.present ? feedChip : feed.note}</p>
              </div>
            </>
          ) : null}

          {jobOn ? (
            <div className="workshop-card">
              <div className="section-label">Job log</div>
              <pre className="workshop-log">{tail}</pre>
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}

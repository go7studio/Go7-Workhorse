import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  WORKSHOP_UNKNOWN,
  type WorkshopInferTile,
  type WorkshopMetricsSnapshot,
  type WorkshopPackListing,
  type WorkshopTone,
  feedAgeLabel,
  feedTone,
  gaugePercent,
  inferTone,
  latestJsonBasename,
  modelsState,
  paintJobStatus,
  paintModelsLine,
  paintQwenParked,
  paintWatts,
  stripLine,
} from "../lib/workshop";
import { dash, useWorkshopLive, type WorkshopFeedLive } from "./workshop-live";

/** Rail view state is local to this window. It is never journaled with the desk. */
const VIEW_KEY = "workhorse.workshop-rail";
type RailView = { expanded: boolean; folded: string[] };

function readView(): RailView {
  try {
    const raw = window.localStorage?.getItem(VIEW_KEY);
    if (!raw) return { expanded: false, folded: [] };
    const parsed = JSON.parse(raw) as Partial<RailView>;
    return {
      expanded: parsed.expanded === true,
      folded: Array.isArray(parsed.folded) ? parsed.folded.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return { expanded: false, folded: [] };
  }
}

function writeView(view: RailView) {
  try {
    window.localStorage?.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* view state is a convenience; losing it costs one click */
  }
}

const INFER_ORDER = ["/healthz", "/readyz", "/v1/models"];

/** One dominant gauge per card: a hairline ring with an accent arc, painted from the current snapshot. */
function Ring({ value, size }: { value: unknown; size: number }) {
  const pct = gaugePercent(value);
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const arc = pct == null ? 0 : (c * pct) / 100;
  return (
    <div
      className={`workshop-ring${pct == null ? " is-unknown" : ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={pct == null ? "GPU unknown" : `GPU ${pct}%`}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="workshop-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        {pct == null ? null : (
          <circle
            className="workshop-ring-arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            strokeDasharray={`${arc} ${c - arc}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="workshop-ring-value">
        <strong>{pct == null ? WORKSHOP_UNKNOWN : Math.round(pct)}</strong>
        {pct == null ? null : <small>%</small>}
      </span>
    </div>
  );
}

function Dot({ tone }: { tone: WorkshopTone }) {
  return <i className={`workshop-dot workshop-dot-${tone}`} aria-hidden="true" />;
}

function Writer({ value }: { value: unknown }) {
  if (value === true) return <><Dot tone="ok" /> one</>;
  if (value === false) return <><Dot tone="warn" /> no</>;
  return <>{WORKSHOP_UNKNOWN}</>;
}

function Chip({ tone, children, title }: { tone: WorkshopTone; children: ReactNode; title?: string }) {
  return (
    <span className={`workshop-chip workshop-chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Label left, value right. The value wraps instead of clipping; there is no track between them. */
function Kv({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="workshop-kv">
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  );
}

function Card({ heading, aside, children }: { heading: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="workshop-card">
      <div className="workshop-card-head">
        <div className="section-label">{heading}</div>
        {aside}
      </div>
      {children}
    </div>
  );
}

function Module({
  pack,
  folded,
  onFold,
  children,
}: {
  pack: WorkshopPackListing;
  folded: boolean;
  onFold: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`workshop-module${folded ? " is-folded" : ""}`} aria-label={pack.name}>
      <div className="workshop-module-head">
        <strong>{pack.name}</strong>
        <span className="row-meta">On · rail</span>
        <button
          className="tiny workshop-fold"
          type="button"
          aria-expanded={!folded}
          title={folded ? `Unfold ${pack.name}` : `Fold ${pack.name}`}
          onClick={onFold}
        >
          {folded ? "›" : "⌄"}
        </button>
      </div>
      {folded ? null : children}
    </section>
  );
}

function inferTiles(metrics: WorkshopMetricsSnapshot | null): WorkshopInferTile[] {
  const byPath = new Map((metrics?.infer ?? []).map((tile) => [tile.path, tile]));
  return INFER_ORDER.map((path) => byPath.get(path) ?? { path, status: "unknown" as const });
}

function inferStatus(tile: WorkshopInferTile): string {
  if (tile.status === "ok") return "up";
  if (tile.status === "unauthorized") return "unauthorized";
  if (tile.status === "down") return "down";
  return WORKSHOP_UNKNOWN;
}

function BoxCards({ metrics, feed }: { metrics: WorkshopMetricsSnapshot | null; feed: WorkshopFeedLive }) {
  const labels = metrics?.labels ?? { trainFence: "nvidia-spark-train-infer", inferInvoke: "Local Compute" };
  const models = modelsState(metrics);
  const tiles = inferTiles(metrics);
  const detail = tiles.find((tile) => typeof tile.detail === "string" && tile.detail.trim());
  const rawWatts = typeof metrics?.powerWatts === "number" ? String(metrics.powerWatts) : undefined;
  const latestPath = typeof metrics?.latestJson === "string" && metrics.latestJson !== WORKSHOP_UNKNOWN ? metrics.latestJson : undefined;
  const feedLine = feed.present ? `present · ${feedAgeLabel(feed.asOf).replace(/^feed · /, "")}` : feed.note;

  return (
    <>
      <Card heading="Box">
        <div className="workshop-box">
          <Ring value={metrics?.gpuUtilPercent} size={56} />
          <div className="workshop-box-kv">
            <Kv label="Watts" value={paintWatts(metrics?.powerWatts)} title={rawWatts} />
            <Kv label="Writer" value={<Writer value={metrics?.oneWriter} />} />
            <Kv label="tok/param" value={dash(metrics?.tokPerParam)} />
          </div>
        </div>
      </Card>

      <Card
        heading={models.kind === "loaded" ? <>Models · {models.ids.length}</> : "Models"}
        aside={models.kind === "train-exclusive" ? <Chip tone="mute">train exclusive</Chip> : null}
      >
        {models.kind === "loaded" ? (
          <div className="workshop-chip-row">
            {models.ids.map((id) => (
              <Chip key={id} tone="mute" title={id}>
                {id}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="workshop-line">{models.line}</p>
        )}
      </Card>

      <Card heading="Infer">
        <div className="workshop-chip-row">
          {tiles.map((tile) => (
            <Chip key={tile.path} tone={inferTone(tile.status)} title={tile.detail}>
              {tile.path.replace(/^\//, "")} · {inferStatus(tile)}
            </Chip>
          ))}
        </div>
        {detail ? (
          <p className="row-meta">
            {detail.path.replace(/^\//, "")} · {detail.detail}
          </p>
        ) : null}
      </Card>

      <Card heading="Router">
        <Kv label="Train fence" value={labels.trainFence} />
        <Kv label="Infer invoke" value={labels.inferInvoke} />
        <Kv label="probeUnit" value={dash(metrics?.exclusiveSidecar?.probeUnit)} />
        <Kv label="qwen" value={paintQwenParked(metrics?.exclusiveSidecar?.qwenParked ?? WORKSHOP_UNKNOWN)} />
        <p className="row-meta workshop-law">labels only, never route/lease/start/stop</p>
      </Card>

      <Card
        heading={
          <>
            Job · <span className="workshop-label-name">{feed.present ? "Bloom soak" : WORKSHOP_UNKNOWN}</span>
          </>
        }
      >
        <Kv label="Status" value={paintJobStatus(metrics, feed.present)} />
        <Kv label="latest.json" value={latestJsonBasename(metrics?.latestJson)} title={latestPath} />
      </Card>

      <Card heading="Feed">
        <p className="workshop-feed-note">{feedLine}</p>
      </Card>
    </>
  );
}

/** The tail follows the newest line unless the user has scrolled up to read. */
function LogTail({ tail }: { tail: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [tail]);
  return (
    <pre
      ref={ref}
      className="workshop-log"
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
    >
      {tail}
    </pre>
  );
}

/**
 * Desk-attached Workshop rail: live watch when any pack is On.
 * Settings → Skills stays install/grant only; breakout remains optional Detach.
 * Collapsed: GPU% · watts · writer · models one-liner. Expanded: Box | Models | Infer | Router | Job | Feed.
 */
export function WorkshopRail() {
  const { packs, metrics, tail, feed } = useWorkshopLive();
  const [view, setView] = useState<RailView>(readView);
  const update = useCallback((next: Partial<RailView>) => {
    setView((prev) => {
      const merged = { ...prev, ...next };
      writeView(merged);
      return merged;
    });
  }, []);

  const on = packs.filter((pack) => pack.on);
  if (on.length === 0) return null;

  const box = on.find((pack) => pack.id === "box-monitor");
  const job = on.find((pack) => pack.id === "job-log");
  const others = on.filter((pack) => pack.id !== "box-monitor" && pack.id !== "job-log");
  const expanded = view.expanded;
  const tone = feedTone(feed.present, feed.asOf);
  const ageLabel = feed.present ? feedAgeLabel(feed.asOf) : "feed · off";
  const shortAge = feed.present ? feedAgeLabel(feed.asOf).replace(/^feed · /, "").replace(/ ago$/, "") : WORKSHOP_UNKNOWN;
  const modelsLine = paintModelsLine(metrics);
  const logLine = tail === WORKSHOP_UNKNOWN ? `log ${WORKSHOP_UNKNOWN}` : "log live";
  const toggleFold = (id: string) =>
    update({ folded: view.folded.includes(id) ? view.folded.filter((item) => item !== id) : [...view.folded, id] });

  if (!expanded) {
    return (
      <aside className="workshop-rail is-collapsed" aria-label="Workshop rail">
        <button
          className="tiny workshop-rail-head"
          type="button"
          aria-expanded={false}
          title="Expand Workshop"
          onClick={() => update({ expanded: true })}
        >
          <span className="section-label">Workshop</span>
        </button>
        <button
          className="workshop-rail-strip"
          type="button"
          title={box ? stripLine(metrics) : job ? logLine : "Workshop"}
          onClick={() => update({ expanded: true })}
        >
          {box ? (
            <>
              <Ring value={metrics?.gpuUtilPercent} size={44} />
              <span className="workshop-rail-kv workshop-rail-watts">{paintWatts(metrics?.powerWatts)}</span>
              <span className="workshop-rail-kv">
                <Writer value={metrics?.oneWriter} />
              </span>
              <span className="workshop-rail-models" title={modelsLine}>
                {modelsLine}
              </span>
              <span className={`row-meta workshop-rail-age workshop-tone-${tone}`}>{shortAge}</span>
            </>
          ) : null}
          {job ? <span className="row-meta workshop-rail-log">{logLine}</span> : null}
          {others.length ? <span className="row-meta">+{others.length}</span> : null}
        </button>
      </aside>
    );
  }

  return (
    <aside className="workshop-rail is-expanded" aria-label="Workshop rail">
      <div className="workshop-rail-head">
        <span className="section-label">Workshop</span>
        <div className="workshop-rail-head-side">
          <Chip tone={tone} title={feed.present ? feed.asOf : feed.note}>
            {ageLabel}
          </Chip>
          <button
            className="tiny workshop-rail-toggle"
            type="button"
            aria-expanded={true}
            title="Collapse Workshop"
            onClick={() => update({ expanded: false })}
          >
            ›
          </button>
        </div>
      </div>

      <div className="workshop-rail-body">
        {box ? (
          <Module pack={box} folded={view.folded.includes(box.id)} onFold={() => toggleFold(box.id)}>
            <BoxCards metrics={metrics} feed={feed} />
          </Module>
        ) : null}

        {job ? (
          <Module pack={job} folded={view.folded.includes(job.id)} onFold={() => toggleFold(job.id)}>
            <div className="workshop-card">
              <LogTail tail={tail} />
            </div>
          </Module>
        ) : null}

        {others.map((pack) => (
          <Module key={pack.id} pack={pack} folded={view.folded.includes(pack.id)} onFold={() => toggleFold(pack.id)}>
            <p className="row-meta">{pack.description}</p>
          </Module>
        ))}
      </div>

      <div className="workshop-rail-foot">
        <button className="tiny" type="button" onClick={() => void window.workhorse?.workshopOpenBreakout?.()}>
          Detach
        </button>
      </div>
    </aside>
  );
}

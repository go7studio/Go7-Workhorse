import { useMemo, useState } from "react";
import {
  CAMPAIGN_PHASE_LABEL,
  missionBoardChip,
  missionBoardKicker,
  missionBoardView,
  type MissionBoardLayerLook,
  type MissionBoardSliceLook,
} from "../lib/mission-board";
import { sameMissionBoardDesk, selectMissionBoardDesk } from "../lib/store-select";
import { useStoreSelector } from "../lib/store";
import { crewDotClass, type CrewDotKind } from "./ChatRow";

function sliceDotKind(slice: MissionBoardSliceLook): CrewDotKind {
  if (slice.word === "Needs you") return "needs-you";
  if (slice.live) return "working";
  if (slice.status === "failed") return "failed";
  if (slice.status === "cancelled" || slice.status === "interrupted" || slice.status === "timed-out") return "stopped";
  return "idle";
}

export function MissionBoard() {
  const desk = useStoreSelector(selectMissionBoardDesk, sameMissionBoardDesk);
  const view = useMemo(() => missionBoardView(desk.session, desk.workers), [desk.session, desk.workers]);
  const [open, setOpen] = useState(false);
  if (!view) return null;
  const kicker = missionBoardKicker(view);
  const chip = missionBoardChip(view);
  const status = view.word ?? (view.running ? "Working…" : undefined);

  return (
    <section className={`mission-board${view.running ? " live" : ""}${open ? " open" : ""}`} aria-label={kicker}>
      <button
        className="mission-board-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`mission-board-mark${view.running ? " pulse" : ""}`} aria-hidden="true" />
        <span className="mission-board-copy">
          <strong>{open ? kicker : chip}</strong>
          {open ? <span title={view.objective}>{view.objective}</span> : null}
        </span>
        {status ? <span className={`mission-board-status${view.tone === "danger" ? " bad" : ""}`}>{status}</span> : null}
        <i className="mission-board-twist" aria-hidden="true" />
      </button>
      <div className="mission-board-slot" aria-hidden={!open}>
        <div className="mission-board-body">
          <ol className="mission-phases" aria-label="Campaign phase">
            {view.phases.map((phase) => (
              <li key={phase.id} className={phase.state} aria-current={phase.state === "current" ? "step" : undefined}>
                {phase.label}
              </li>
            ))}
          </ol>
          {view.criteria.length > 0 ? (
            <p className="mission-criteria" title={view.criteria.join(" · ")}>
              {view.criteria.join(" · ")}
            </p>
          ) : null}
          <div className="mission-layers">
            {view.layers.map((layer) => (
              <MissionLayer key={layer.iteration} layer={layer} onOpen={desk.selectSession} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function MissionLayer({
  layer,
  onOpen,
}: {
  layer: MissionBoardLayerLook;
  onOpen: (id: string) => void;
}) {
  return (
    <div className={`mission-layer${layer.current ? " current" : " prior"}`}>
      <span className="mission-layer-label">
        Pass {layer.iteration} · {CAMPAIGN_PHASE_LABEL[layer.phase]}
      </span>
      {layer.slices.length === 0 ? (
        <p className="mission-layer-empty">Waiting for the first worker.</p>
      ) : (
        layer.slices.map((slice) => (
          <button
            key={slice.sessionId}
            className={`mission-slice${slice.live ? " live" : ""}${slice.outcome === "blocked" || slice.status === "failed" ? " bad" : ""}`}
            type="button"
            onClick={() => onOpen(slice.sessionId)}
          >
            <span className={`dot ${slice.provider}${crewDotClass(sliceDotKind(slice))}`} aria-hidden="true" />
            <span className="mission-slice-copy">
              <strong title={slice.slice || slice.title}>{slice.title}</strong>
              <span className={slice.outcome === "blocked" || slice.status === "failed" ? "bad" : undefined}>{slice.word}</span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}

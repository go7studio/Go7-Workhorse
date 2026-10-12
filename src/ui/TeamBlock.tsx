import { useState } from "react";
import { copyText } from "../lib/copy-text";
import { useStore, useStoreSelector, type Store } from "../lib/store";
import { whoIsInChat } from "../lib/team";
import type { Project } from "../lib/types";

const selectTeam = (store: Store) => store.team;

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * The people sharing this project. The crew tray is still the bots; this is
 * the teammates, the inbox owner, and the project's usage across every seat.
 */
export function TeamBlock({ project }: { project: Project }) {
  const store = useStore();
  const { team } = store;
  const snap = team.snapshots[project.id];
  const [note, setNote] = useState("");
  const [handTo, setHandTo] = useState("");
  const [ceiling, setCeiling] = useState("");
  const [locator, setLocator] = useState("");

  const say = (result: { message: string; locator?: string }) => {
    setNote(result.message);
    if (result.locator) setLocator(result.locator);
  };

  if (!project.team) {
    return (
      <div className="link-block">
        <div className="link-head">
          <span className="section-label" style={{ margin: 0 }}>
            Team
          </span>
          <button className="tiny" type="button" onClick={() => void team.share(project.id).then(say)}>
            Share project
          </button>
        </div>
        <p className="row-meta">
          {note || "Share with a teammate on another desk. Logins, keys, Permission, Sandbox, and folders stay on each computer."}
        </p>
      </div>
    );
  }

  const shown = locator || snap?.locator || "";
  const others = (snap?.members ?? []).filter((seat) => seat !== snap?.inboxOwner);
  const offline = snap?.total.offline ?? [];
  const ownerAway = Boolean(snap?.inboxOwner && offline.includes(snap.inboxOwner));
  const hosts = store.settings.localCompute?.hosts ?? [];
  const sharable = store.settings.workshop.packs.filter((pack) => pack.on && hosts.some((host) => host.id === pack.hostId));

  return (
    <div className="link-block">
      <div className="link-head">
        <span className="section-label" style={{ margin: 0 }}>
          Team
        </span>
        <button
          className="tiny"
          type="button"
          disabled={!shown}
          onClick={() => {
            void copyText(shown).then((copied) =>
              setNote(copied ? "Locator copied. Your teammate pastes it under New project → Join a team." : shown),
            );
          }}
        >
          Copy locator
        </button>
      </div>
      <ul className="chip-list">
        <li className="chip">
          <span>
            <strong>People</strong>
            <span className="path">
              {(snap?.members ?? []).map((seat) => `@${seat}${offline.includes(seat) ? " (desk off)" : ""}`).join(", ") || "Reading the journal…"}
            </span>
          </span>
        </li>
        <li className="chip">
          <span>
            <strong>Inbox owner</strong>
            <span className="path">{snap?.inboxOwner ? `@${snap.inboxOwner}` : "—"}</span>
            {ownerAway && snap?.waiting.length ? (
              <span className="row-meta">Their desk is off. Tool cards wait on it until they answer; taking the inbox does not allow anything.</span>
            ) : null}
          </span>
          {snap?.inboxOwner !== team.seat ? (
            <button className="tiny" type="button" onClick={() => void team.takeInbox(project.id).then(say)}>
              Take inbox
            </button>
          ) : null}
        </li>
        {snap?.waiting.map((card) => (
          <li key={card.requestId} className="chip">
            <span>
              <strong>Waiting on @{card.seat}'s desk</strong>
              <span className="path">
                {card.tool} — {card.detail}
              </span>
            </span>
          </li>
        ))}
        <li className="chip">
          <span>
            <strong>Project usage{snap?.total.partial ? " (partial)" : ""}</strong>
            <span className="path">
              {snap
                ? `${money(snap.total.costUsd)} · ${snap.total.tokens.toLocaleString()} tokens${
                    snap.ceiling?.usd ? ` of ${money(snap.ceiling.usd)} shared ceiling` : ""
                  }`
                : "—"}
            </span>
            {snap?.total.bySeat.length ? (
              <span className="row-meta">{snap.total.bySeat.map((row) => `@${row.seat} ${money(row.costUsd)}`).join(" · ")}</span>
            ) : null}
            {snap?.total.partial ? (
              <span className="row-meta">Partial: {offline.map((seat) => `@${seat}`).join(", ")} is off, so their newest use may be missing.</span>
            ) : null}
          </span>
        </li>
        {snap?.grants.map((grant) => (
          <li key={grant.pack} className="chip">
            <span>
              <strong>
                Workshop · {grant.pack} via {grant.host}
              </strong>
              <span className="row-meta">{grant.ready ? "Ready on this desk with its own token." : grant.message}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="actions">
        {others.length > 0 ? (
          <>
            <select value={handTo} onChange={(event) => setHandTo(event.target.value)} aria-label="Hand the inbox to">
              <option value="">Hand inbox to…</option>
              {others.map((seat) => (
                <option key={seat} value={seat}>
                  @{seat}
                </option>
              ))}
            </select>
            <button className="tiny" type="button" disabled={!handTo} onClick={() => void team.handInbox(project.id, handTo).then(say)}>
              Hand over
            </button>
          </>
        ) : null}
        <input
          value={ceiling}
          inputMode="decimal"
          placeholder="Shared ceiling $"
          aria-label="Shared ceiling in dollars"
          onChange={(event) => setCeiling(event.target.value)}
        />
        <button
          className="tiny"
          type="button"
          onClick={() => {
            const usd = Number(ceiling);
            void team.setCeiling(project.id, Number.isFinite(usd) && usd > 0 ? usd : null).then(say);
          }}
        >
          Set ceiling
        </button>
        {sharable.map((pack) => (
          <button key={pack.id} className="tiny" type="button" onClick={() => void team.shareWorkshopGrant(project.id, pack.id).then(say)}>
            Share {pack.id}
          </button>
        ))}
      </div>
      {note || snap?.error ? <p className="row-meta">{note || snap?.error}</p> : null}
    </div>
  );
}

/** Join from a pasted locator, inside New project. */
export function JoinTeamField({ onJoined }: { onJoined: () => void }) {
  const { team } = useStore();
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="sheet-field">
      <span className="sheet-label">Join a team</span>
      <span className="sheet-name">
        <input
          value={text}
          placeholder="Paste a team locator"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </span>
      <div className="actions">
        <button
          className="tiny"
          type="button"
          disabled={!text.trim()}
          onClick={() =>
            void team.join(text).then((result) => {
              setNote(result.message);
              if (result.ok) onJoined();
            })
          }
        >
          Join
        </button>
      </div>
      {note ? <p className="row-meta">{note}</p> : null}
    </div>
  );
}

/** Who is in this chat right now. Live only; nothing here is replayed. */
export function ChatPresence({ session }: { session: { id: string; projectId: string | null; team?: { runningOn?: string; seat: string } } }) {
  const team = useStoreSelector(selectTeam);
  const snap = session.projectId ? team.snapshots[session.projectId] : undefined;
  if (!snap) return null;
  const here = whoIsInChat(snap.presence, session.id, Date.now());
  const elsewhere = session.team?.runningOn && session.team.runningOn !== team.device;
  if (here.length === 0 && !elsewhere) return null;
  return (
    <p className="row-meta" aria-live="polite">
      {here.length > 0 ? `In this chat: ${here.map((seat) => `@${seat}`).join(", ")}` : ""}
      {elsewhere ? `${here.length > 0 ? " · " : ""}Running on @${session.team?.seat}'s desk — stop it there.` : ""}
    </p>
  );
}

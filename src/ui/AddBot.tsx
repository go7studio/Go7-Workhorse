import { useEffect, useState } from "react";
import { BOT_COLORS, draftReady } from "../lib/custom-bots";
import { formatWindow } from "../lib/models";
import { useStore } from "../lib/store";
import type { LlmLink } from "../lib/types";
import { BotForm } from "./BotForm";

const CATALOG: {
  id: "grok" | "codex" | "claude" | "own";
  name: string;
  hint: string;
}[] = [
  { id: "grok", name: "Grok", hint: "Local Grok Build login on this machine." },
  { id: "codex", name: "Codex", hint: "Local Codex login on this machine." },
  { id: "claude", name: "Claude", hint: "Local Claude Code harness and login on this machine." },
  { id: "own", name: "Your own", hint: "Name, color, API URL, and key. Test, then Create." },
];

type Stage = "catalog" | "own" | "grok" | "codex" | "claude";

export function addBotChoices(llms: Record<"grok" | "codex" | "claude", Pick<LlmLink, "connected">>) {
  return CATALOG.filter((item) => item.id === "own" || !llms[item.id].connected);
}

export function AddBot() {
  const store = useStore();
  const draft = store.settings.llms.custom;
  const choices = addBotChoices(store.settings.llms);
  const [stage, setStage] = useState<Stage>(() => (choices.length === 1 ? choices[0].id : "catalog"));
  const [probeNote, setProbeNote] = useState("");
  const [probing, setProbing] = useState(false);

  const leaveChoice = () => {
    if (addBotChoices(store.settings.llms).length <= 1) store.closeAddBot();
    else setStage("catalog");
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (stage === "catalog") store.closeAddBot();
      else leaveChoice();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [stage, store]);

  const pick = (id: (typeof CATALOG)[number]["id"]) => {
    setProbeNote("");
    if (id === "own") {
      if (!draft.apiKey.trim() && !draft.baseUrl.trim()) store.refreshCustomLogin();
      setStage("own");
      return;
    }
    if (id === "grok") store.refreshGrokLogin();
    if (id === "codex") store.refreshCodexLogin();
    if (id === "claude") store.refreshClaudeLogin();
    setStage(id);
  };

  return (
    <section className="picker project-home add-bot">
      {stage === "catalog" && (
        <>
          <header className="project-hero">
            <div className="link-head">
              <p className="eyebrow">Desk</p>
              <button className="tiny" type="button" onClick={store.closeAddBot}>
                Back
              </button>
            </div>
            <h2>Add a bot</h2>
            <p className="lede">
              Pick a built-in vendor, or wire your own API. Only what you add sits on the desk.
            </p>
          </header>
          <div className="add-bot-catalog">
            {choices.map((item) => (
              <button key={item.id} className="add-bot-choice" type="button" onClick={() => pick(item.id)}>
                <span className={`llm-mark ${item.id}${item.id === "own" ? " plus" : ""}`} aria-hidden="true">
                  {item.id === "own" ? "+" : "Off"}
                </span>
                <strong>{item.name}</strong>
                <span>{item.hint}</span>
              </button>
            ))}
          </div>
          <p className="row-meta add-bot-hint">You can also ask Grok or Codex in chat to set one up.</p>
        </>
      )}

      {stage === "own" && (
        <>
          <header className="project-hero">
            <div className="link-head">
              <p className="eyebrow">Your own</p>
              <button className="tiny" type="button" onClick={leaveChoice}>
                Back
              </button>
            </div>
            <h2>New bot</h2>
            <p className="lede">
              Pick a known provider or paste a key. Test the API, then Create.
            </p>
            {draft.source === "openclaw" ? (
              <p className="row-meta">Detected MiniMax settings from OpenClaw. The API key stays on this Mac.</p>
            ) : draft.source === "env" ? (
              <p className="row-meta">Detected MiniMax settings from this app's environment.</p>
            ) : null}
          </header>

          <div className="add-bot-preview" aria-hidden="true">
            <span className="llm-mark on" style={{ borderColor: draft.color || BOT_COLORS[0].value }}>
              On
            </span>
            <div>
              <strong>{draft.name?.trim() || "Untitled"}</strong>
              <em>{draft.model.trim() || "No model yet"}</em>
            </div>
          </div>

          <BotForm
            value={{
              name: draft.name ?? "",
              color: draft.color || BOT_COLORS[0].value,
              model: draft.model,
              baseUrl: draft.baseUrl,
              apiKey: draft.apiKey,
              contextWindow: draft.contextWindow,
            }}
            onChange={(patch) => store.updateCustomLlm({ ...patch, source: "manual" })}
          />

          <p className="row-meta">
            {probing
              ? "Testing API…"
              : probeNote ||
                (draft.tested
                  ? `Tested. ${formatWindow(draft.contextWindow)} context.`
                  : "Test the API before Create.")}
          </p>
          <div className="actions add-bot-actions">
            <button
              className="tiny"
              type="button"
              disabled={probing}
              onClick={() => {
                setProbing(true);
                void store.probeCustomDraft().then((result) => {
                  setProbeNote(result.message);
                  setProbing(false);
                });
              }}
            >
              Test API
            </button>
            <button
              className="primary"
              type="button"
              disabled={!draftReady(draft)}
              onClick={() => {
                const id = store.createCustomBot();
                if (id) store.closeAddBot();
              }}
            >
              Create
            </button>
          </div>
        </>
      )}

      {(stage === "grok" || stage === "codex" || stage === "claude") && (
        <VendorStatus stage={stage} onBack={leaveChoice} onDesk={store.closeAddBot} />
      )}
    </section>
  );
}

function VendorStatus({
  stage,
  onBack,
  onDesk,
}: {
  stage: "grok" | "codex" | "claude";
  onBack: () => void;
  onDesk: () => void;
}) {
  const store = useStore();
  const link = store.settings.llms[stage];
  const linked = Boolean(link?.connected);
  const found = Boolean(link?.available);
  const name = stage === "grok" ? "Grok" : stage === "codex" ? "Codex" : "Claude";
  const copy = linked && found
    ? `Detected the local ${name} harness and login on this machine. It is ready on the desk.`
    : linked
      ? `${name} is on the desk, but its harness or login is not currently available. Recheck after signing in or reinstalling it.`
    : found
      ? `Detected the local ${name} harness and login on this machine. Add it to the desk.`
      : stage === "grok"
        ? "Grok binary or login not found on this machine."
        : stage === "codex"
          ? "Codex ACP adapter or login not found on this machine."
          : "Claude ACP adapter or login not found on this machine.";

  return (
    <>
      <header className="project-hero">
        <div className="link-head">
          <p className="eyebrow">Desk</p>
          <button className="tiny" type="button" onClick={onBack}>
            Back
          </button>
        </div>
        <h2>{name}</h2>
        <p className="lede">{copy}</p>
      </header>
      <div className="add-bot-preview">
        <span className={`llm-mark ${stage}${linked ? " on" : ""}`} aria-hidden="true">
          {linked ? "On" : "Off"}
        </span>
        <div>
          <strong>{name}</strong>
          <em>{linked && found ? "Ready on the desk" : linked ? "Needs attention" : found ? "Ready to add" : "Not found"}</em>
        </div>
      </div>
      <div className="actions add-bot-actions">
        <button
          className="tiny"
          type="button"
          onClick={() =>
            stage === "grok"
              ? store.refreshGrokLogin()
              : stage === "codex"
                ? store.refreshCodexLogin()
                : store.refreshClaudeLogin()
          }
        >
          Recheck
        </button>
        {found && !linked && (
          <button
            className="primary"
            type="button"
            onClick={() => {
              store.setLlmConnected(stage, true);
              onDesk();
            }}
          >
            Add to desk
          </button>
        )}
        {linked && (
          <button className="tiny" type="button" onClick={() => store.setLlmConnected(stage, false)}>
            Remove from desk
          </button>
        )}
      </div>
    </>
  );
}

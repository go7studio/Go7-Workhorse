import { useEffect, useState } from "react";
import { BOT_COLORS, draftReady } from "../lib/custom-bots";
import { formatWindow } from "../lib/models";
import { draftFromProvider, findProvider } from "../lib/provider-catalog";
import { useStore } from "../lib/store";
import type { LlmLink } from "../lib/types";
import { BotForm } from "./BotForm";
import { GrokBotWakeSetup } from "./GrokBotWakeSetup";

const CATALOG: {
  id: "grok" | "codex" | "claude" | "cursor" | "grok-bot" | "dgx-spark" | "own";
  name: string;
  hint: string;
}[] = [
  { id: "grok", name: "Grok", hint: "Local Grok Build CLI." },
  { id: "codex", name: "Codex", hint: "Local Codex." },
  { id: "claude", name: "Claude", hint: "Local Claude Code." },
  { id: "cursor", name: "Cursor", hint: "Local Cursor Agent." },
  { id: "grok-bot", name: "Grok Bot", hint: "Private local bridge. Instant replies are optional." },
  { id: "dgx-spark", name: "DGX Spark", hint: "Qwen on the Spark. NVIDIA Sync local-forwards 8788." },
  { id: "own", name: "Your own", hint: "API URL and key." },
];

type Stage = "catalog" | "own" | "grok" | "codex" | "claude" | "cursor" | "grok-bot" | "dgx-spark";

const ALWAYS_OFFERED = new Set<(typeof CATALOG)[number]["id"]>(["grok-bot", "dgx-spark", "own"]);

export function addBotChoices(llms: Record<"grok" | "codex" | "claude" | "cursor", Pick<LlmLink, "connected">>) {
  return CATALOG.filter((item) => ALWAYS_OFFERED.has(item.id) || !llms[item.id as "grok" | "codex" | "claude" | "cursor"]?.connected);
}

type StockStage = "grok" | "codex" | "claude" | "cursor";

export function vendorStatusCopy(stage: StockStage, link: Pick<LlmLink, "available" | "connected" | "needsAuth">) {
  const linked = Boolean(link?.connected);
  const needsAuth = Boolean(link?.needsAuth);
  const found = Boolean(link?.available) || needsAuth;
  if (linked && found && !needsAuth) return "Ready on the desk";
  if (linked) return "Needs attention";
  if (needsAuth) return stage === "cursor" ? "Installed - sign in with agent login" : "Needs auth";
  if (found) return "Ready to add";
  return stage === "cursor" ? "Needs Cursor Agent CLI" : "Not found";
}

export function vendorSetupHelpCopy(stage: StockStage, link: Pick<LlmLink, "available" | "connected" | "needsAuth">) {
  const linked = Boolean(link?.connected);
  const needsAuth = Boolean(link?.needsAuth);
  const found = Boolean(link?.available) || needsAuth;
  if (stage === "cursor" && !linked && !found) {
    return "Install Cursor Agent CLI so cursor-agent or agent is on PATH, then Recheck.";
  }
  if (stage === "cursor" && needsAuth && !linked) {
    return "Run agent login in PowerShell or Terminal, then Recheck.";
  }
  return "";
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
    if (id === "grok-bot") {
      const preset = findProvider(id);
      if (preset) {
        store.updateCustomLlm({
          ...draftFromProvider(preset),
          apiKey: "local",
          tested: true,
          source: "manual",
        });
      }
      setStage(id);
      return;
    }
    if (id === "dgx-spark") {
      const preset = findProvider(id);
      if (preset) {
        store.updateCustomLlm({
          ...draftFromProvider(preset),
          apiKey: "",
          tested: false,
          source: "manual",
        });
      }
      setStage(id);
      return;
    }
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
        </>
      )}

      {(stage === "own" || stage === "grok-bot" || stage === "dgx-spark") && (
        <>
          <header className="project-hero">
            <div className="link-head">
              <p className="eyebrow">
                {stage === "grok-bot" ? "Grok Bot" : stage === "dgx-spark" ? "DGX Spark" : "Your own"}
              </p>
              <button className="tiny" type="button" onClick={leaveChoice}>
                Back
              </button>
            </div>
            <h2>{stage === "grok-bot" ? "Connect Grok Bot" : stage === "dgx-spark" ? "Connect DGX Spark" : "New bot"}</h2>
            {stage === "grok-bot" ? (
              <p className="lede">Add the private local bot now. You can finish its optional instant-reply connection later.</p>
            ) : stage === "dgx-spark" ? (
              <p className="lede">
                NVIDIA Sync is SSH. Local-forward 8788 to the Spark gateway, paste the owner bearer, then Test API — that
                call collects /v1/models so Qwen and anything else the box serves can be ticked.
              </p>
            ) : draft.source === "openclaw" ? (
              <p className="row-meta">Imported MiniMax key from OpenClaw config. This is not harness integration.</p>
            ) : draft.source === "env" ? (
              <p className="row-meta">Imported MiniMax from the environment.</p>
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
              models: draft.models,
              discovered: draft.discovered,
            }}
            identityOnly={stage === "grok-bot"}
            onChange={(patch) => store.updateCustomLlm({ ...patch, source: "manual" })}
          />

          {stage === "grok-bot" ? <GrokBotWakeSetup /> : null}

          {stage === "own" || stage === "dgx-spark" ? (
            <p className="row-meta">
              {probing
                ? "Testing API…"
                : probeNote ||
                  (draft.tested
                    ? `Tested. ${formatWindow(draft.contextWindow)} context.`
                    : stage === "dgx-spark"
                      ? "Test the API before Create. That GET is how the desk collects the models this box is delivering."
                      : "Test the API before Create.")}
            </p>
          ) : null}
          <div className="actions add-bot-actions">
            {stage === "own" || stage === "dgx-spark" ? (
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
            ) : null}
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

      {(stage === "grok" || stage === "codex" || stage === "claude" || stage === "cursor") && (
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
  stage: "grok" | "codex" | "claude" | "cursor";
  onBack: () => void;
  onDesk: () => void;
}) {
  const store = useStore();
  const link = store.settings.llms[stage];
  const linked = Boolean(link?.connected);
  const needsAuth = Boolean(link?.needsAuth);
  const found = Boolean(link?.available) || needsAuth;
  const name = stage === "grok" ? "Grok" : stage === "codex" ? "Codex" : stage === "cursor" ? "Cursor" : "Claude";
  const setupHelp = vendorSetupHelpCopy(stage, link);

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
      </header>
      <div className="add-bot-preview">
        <span className={`llm-mark ${stage}${linked ? " on" : ""}`} aria-hidden="true">
          {linked ? "On" : "Off"}
        </span>
        <div>
          <strong>{name}</strong>
          <em>{vendorStatusCopy(stage, link)}</em>
        </div>
      </div>
      {setupHelp ? <p className="row-meta vendor-setup-help">{setupHelp}</p> : null}
      <div className="actions add-bot-actions">
        <button
          className="tiny"
          type="button"
          onClick={() =>
            stage === "grok"
              ? store.refreshGrokLogin()
              : stage === "codex"
                ? store.refreshCodexLogin()
                : stage === "cursor"
                  ? store.refreshCursorLogin()
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

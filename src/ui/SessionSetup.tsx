import { useEffect, useRef, useState } from "react";
import { customBotEnabled } from "../lib/custom-bots";
import { defaultModel, effortStopAt, effortStopPos, effortsFor, modelsFor, withEffort } from "../lib/models";
import { hasAttachedLlm, vendorEnabled, vendorLabel, vendorTint } from "../lib/settings";
import { useActiveSession, useStore } from "../lib/store";
import { vendorTidePercent } from "../lib/usage";
import { sessionEnvironmentKind } from "../lib/session-environment";
import type { EffortLevel, PermissionMode, ProviderId, SandboxProfile } from "../lib/types";
import { capabilitiesFor } from "../lib/provider-capabilities";

const PERMISSIONS: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "ask", label: "Ask", hint: "Pause before tools. You decide each time." },
  { id: "accept-edits", label: "Accept edits", hint: "File edits run. Commands still ask." },
  { id: "always-approve", label: "Always", hint: "Trusted for this chat. You can change it later." },
  { id: "plan", label: "Plan", hint: "Read and propose only. No edits until you say so." },
];

const SANDBOXES: { id: SandboxProfile; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Full machine. Fastest, least contained." },
  { id: "workspace", label: "Workspace", hint: "Writes stay in the project folder." },
  { id: "read-only", label: "Read-only", hint: "Can look. Writes are blocked." },
  { id: "strict", label: "Strict", hint: "Tightest box. Writes and shell stay blocked." },
];

const SETUP_VENDORS: Exclude<ProviderId, "custom">[] = ["grok", "codex", "claude"];

export function SessionSetup({ onClose }: { onClose: () => void }) {
  const session = useActiveSession();
  const {
    setMode,
    setSandbox,
    setSessionEffort,
    setSessionEnvironment,
    setSessionModel,
    openSettings,
    settings,
    projects,
    usage,
    grokPlan,
    codexPlan,
    claudePlan,
    customPlans,
    refreshGrokPlan,
    refreshCodexPlan,
    refreshClaudePlan,
    refreshCustomPlans,
  } = useStore();
  const root = useRef<HTMLDivElement>(null);
  const [slide, setSlide] = useState<number | null>(null);
  const [environmentBusy, setEnvironmentBusy] = useState<"local" | "worktree" | null>(null);
  const [environmentNote, setEnvironmentNote] = useState("");

  useEffect(() => {
    refreshGrokPlan();
    refreshCodexPlan();
    refreshClaudePlan();
    refreshCustomPlans();
  }, [refreshGrokPlan, refreshCodexPlan, refreshClaudePlan, refreshCustomPlans]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (root.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-session-setup]")) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!session) return null;
  const bot = session.customBotId
    ? settings.customBots.find((item) => item.id === session.customBotId)
    : undefined;
  const project = projects.find((item) => item.id === session.projectId);
  const localRoot = project?.folders[0]?.path ?? "";
  const environmentKind = sessionEnvironmentKind(session.environment);
  const chooseEnvironment = async (kind: "local" | "worktree") => {
    setEnvironmentBusy(kind);
    setEnvironmentNote("");
    try {
      const result = await setSessionEnvironment(kind);
      setEnvironmentNote(result.message);
    } finally {
      setEnvironmentBusy(null);
    }
  };
  const focus: ProviderId | `bot:${string}` = bot ? `bot:${bot.id}` : session.provider;
  const used = vendorTidePercent(
    { focus, provider: session.provider, key: bot?.id ?? session.provider },
    { grok: grokPlan, codex: codexPlan, claude: claudePlan, custom: customPlans },
    usage ?? [],
    settings.usageBudgets[session.provider],
    bot,
  );
  const stockTint =
    session.provider !== "custom" ? vendorTint(session.provider, settings.llms[session.provider]) : undefined;
  const vendorColor =
    bot?.color ?? stockTint ?? `var(--${session.provider === "custom" ? "custom" : session.provider})`;
  const thinking = effortsFor(session.provider, session.model);
  const capabilities = capabilitiesFor(session.provider);
  useEffect(() => {
    const levels = effortsFor(session.provider, session.model);
    if (levels.length === 0) return;
    if (levels.some((item) => item.id === session.effort)) return;
    const next = withEffort(session.provider, session.model, session.effort);
    if (next) setSessionEffort(next);
  }, [session.effort, session.model, session.provider, setSessionEffort]);
  const thinkIndex = Math.max(0, thinking.findIndex((item) => item.id === session.effort));
  const hoverIndex =
    slide == null || thinking.length === 0 ? thinkIndex : effortStopAt(slide, thinking.length);
  const thinkNow = thinking[hoverIndex] ?? thinking[thinkIndex];

  return (
    <div
      className={`session-setup vendor-${session.provider}`}
      ref={root}
      data-session-setup
      style={{
        ["--setup-vendor" as string]: vendorColor,
        ["--setup-used" as string]: `${Math.round(used)}%`,
      }}
    >
      <div className="setup-tide" aria-hidden="true">
        <span className="setup-tide-water" />
        <span className="setup-tide-wave one" />
        <span className="setup-tide-wave two" />
        <span className="setup-tide-glint" />
      </div>
      <div className="setup-intro">
        <strong>This chat</strong>
        <p>Brain, thinking, and what this chat may do.</p>
      </div>

      <section className="setup-block">
        <div className="section-label">Model</div>
        <div className="setup-effort" role="listbox" aria-label="Model">
          {modelsFor(session.provider).map((model) => (
            <button
              key={model.id}
              className={session.model === model.id ? "on" : undefined}
              type="button"
              onClick={() => setSessionModel(session.provider, model.id)}
            >
              {model.name}
            </button>
          ))}
        </div>
      </section>

      <section className="setup-block">
        <div className="section-label">Vendor</div>
        <div className="setup-effort" role="listbox" aria-label="Vendor">
          {SETUP_VENDORS.filter((id) => vendorEnabled(settings.llms[id])).map((id) => {
            const on = session.provider === id;
            const tint = vendorTint(id, settings.llms[id]);
            return (
              <button
                key={id}
                className={`${id}${on ? " on" : ""}`}
                type="button"
                disabled={capabilities.security.network === "unavailable"}
                style={tint ? { ["--setup-chip" as string]: tint } : undefined}
                onClick={() => setSessionModel(id, defaultModel(id).id)}
              >
                {vendorLabel(id, settings.llms[id])}
              </button>
            );
          })}
          {!hasAttachedLlm(settings) && (
            <button type="button" onClick={() => openSettings("llms")}>
              Attach LLM
            </button>
          )}
          {settings.customBots.filter((bot) => customBotEnabled(bot)).map((bot) => (
            <button
              key={bot.id}
              className={`custom${session.customBotId === bot.id ? " on" : ""}`}
              type="button"
              style={{ ["--setup-chip" as string]: bot.color }}
              onClick={() => setSessionModel("custom", bot.model, bot.id)}
            >
              {bot.name}
            </button>
          ))}
        </div>
      </section>

      <section className="setup-block">
        <div className="section-label">Environment</div>
        <div className="setup-effort" role="listbox" aria-label="Environment">
          <button
            className={environmentKind === "local" ? "on" : undefined}
            type="button"
            disabled={environmentBusy !== null}
            onClick={() => void chooseEnvironment("local")}
          >
            {environmentBusy === "local" ? "Opening…" : "Local"}
          </button>
          <button
            className={environmentKind === "worktree" ? "on" : undefined}
            type="button"
            disabled={!localRoot || environmentBusy !== null}
            title={localRoot ? "Create an isolated Git worktree for this chat" : "Link a project folder first"}
            onClick={() => void chooseEnvironment("worktree")}
          >
            {environmentBusy === "worktree" ? "Creating…" : "Worktree"}
          </button>
        </div>
        <p className="setup-note">
          {environmentNote ||
            (environmentKind === "worktree" && session.environment?.kind === "worktree"
              ? session.environment.path
              : localRoot || "Link a project folder to choose an execution environment.")}
        </p>
      </section>

      {thinking.length > 0 && (
        <section className="setup-block">
          <div className="section-label">Thinking</div>
          <div
            className={`setup-slider${slide != null ? " dragging" : ""}`}
            style={{
              ["--stops" as string]: String(thinking.length),
              ["--at" as string]: String(hoverIndex),
              ["--pos" as string]:
                slide != null
                  ? `${Math.min(1, Math.max(0, slide)) * 100}%`
                  : `${effortStopPos(thinkIndex, thinking.length) * 100}%`,
            }}
          >
            <div
              className="setup-slider-line"
              onPointerDown={(event) => {
                const line = event.currentTarget;
                const along = (clientX: number) => {
                  const box = line.getBoundingClientRect();
                  return Math.min(1, Math.max(0, (clientX - box.left) / Math.max(1, box.width)));
                };
                const snap = (value: number) => {
                  const next = thinking[effortStopAt(value, thinking.length)];
                  if (next) setSessionEffort(next.id as EffortLevel);
                };
                setSlide(along(event.clientX));
                const move = (next: PointerEvent) => setSlide(along(next.clientX));
                const up = (next: PointerEvent) => {
                  const value = along(next.clientX);
                  snap(value);
                  setSlide(null);
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
            >
              <span className="setup-slider-fill" />
              <span className="setup-slider-thumb" />
              <input
                type="range"
                min={0}
                max={Math.max(0, thinking.length - 1)}
                step={1}
                value={thinkIndex}
                aria-label="Thinking"
                aria-valuetext={thinkNow?.label}
                onChange={(event) => {
                  const next = thinking[Number(event.target.value)];
                  if (next) setSessionEffort(next.id as EffortLevel);
                }}
              />
            </div>
            <div className="setup-slider-marks">
              {thinking.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  className={index === hoverIndex ? "on" : undefined}
                  style={{ ["--i" as string]: String(index) }}
                  onClick={() => setSessionEffort(item.id as EffortLevel)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <p className="setup-note">{thinkNow?.hint ?? "More time on hard steps. The next turn uses this."}</p>
        </section>
      )}

      <div className="setup-split">
        <section className="setup-block">
          <div className="section-label">Permission</div>
          <div className="setup-grid">
            {PERMISSIONS.map((item) => (
              <button
                key={item.id}
                className={session.mode === item.id ? "on" : undefined}
                type="button"
                disabled={capabilities.security.network === "unavailable"}
                onClick={() => setMode(item.id)}
              >
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="setup-block">
          <div className="section-label">Sandbox</div>
          <div className="setup-grid">
            {SANDBOXES.map((item) => (
              <button
                key={item.id}
                className={session.sandbox === item.id ? "on" : undefined}
                type="button"
                onClick={() => setSandbox(item.id)}
              >
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

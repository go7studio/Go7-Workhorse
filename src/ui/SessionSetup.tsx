import { useEffect, useRef, useState } from "react";
import { customBotEnabled } from "../lib/custom-bots";
import { defaultModel, effortStopAt, effortStopPos, effortsFor, formatWindow, modelsFor, withEffort } from "../lib/models";
import { hasAttachedLlm, vendorEnabled, vendorLabel, vendorTint } from "../lib/settings";
import { sessionEnvironmentKind } from "../lib/session-environment";
import { useActiveSession, useStore } from "../lib/store";
import { vendorTidePercent } from "../lib/usage";
import type { EffortLevel, PermissionMode, ProviderId, SandboxProfile } from "../lib/types";
import { capabilitiesFor } from "../lib/provider-capabilities";

const PERMISSIONS: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "ask", label: "Ask each time", hint: "Pause before tools so you stay in control." },
  { id: "accept-edits", label: "Accept edits", hint: "File edits run; commands still ask." },
  { id: "always-approve", label: "Always allow", hint: "Run trusted tools without pausing." },
  { id: "plan", label: "Plan mode", hint: "Research and propose; do not make edits." },
];

const SANDBOXES: { id: SandboxProfile; label: string; hint: string }[] = [
  { id: "off", label: "Full access", hint: "Sandbox off; can reach the full machine." },
  { id: "workspace", label: "Workspace only", hint: "Writes stay inside the project folder." },
  { id: "read-only", label: "Read-only", hint: "Files can be inspected, never changed." },
  { id: "strict", label: "Strict", hint: "Blocks writes and shell commands." },
];

const PERMISSION_ICONS: Record<PermissionMode, string> = {
  ask: "?",
  "accept-edits": "✓",
  "always-approve": "∞",
  plan: "◇",
};

const SANDBOX_ICONS: Record<SandboxProfile, string> = {
  off: "◎",
  workspace: "▣",
  "read-only": "◉",
  strict: "◆",
};

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
  const selectedPermission = PERMISSIONS.find((item) => item.id === session.mode) ?? PERMISSIONS[0];
  const selectedSandbox = SANDBOXES.find((item) => item.id === session.sandbox) ?? SANDBOXES[0];

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
      <header className="setup-intro">
        <div>
          <span className="setup-kicker">This chat</span>
          <strong>Model &amp; chat settings</strong>
          <p>Choose the brain, reasoning depth, and access for this conversation.</p>
        </div>
        <button className="setup-close" type="button" aria-label="Close model and chat settings" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="setup-top-grid">
        <section className="setup-card setup-model-card">
        <div className="setup-heading">
          <div>
            <strong>Model</strong>
            <span>Pick a provider, then choose one of its available models.</span>
          </div>
          <span className="setup-current">{formatWindow(modelsFor(session.provider).find((model) => model.id === session.model)?.contextWindow ?? 0)} context</span>
        </div>

        <div className="setup-subgroup">
          <div className="section-label">Provider</div>
          <div className="setup-effort setup-vendors" role="listbox" aria-label="Vendor">
            {SETUP_VENDORS.filter((id) => vendorEnabled(settings.llms[id])).map((id) => {
              const on = session.provider === id;
              const tint = vendorTint(id, settings.llms[id]);
              return (
                <button
                  key={id}
                  className={`${id}${on ? " on" : ""}`}
                  type="button"
                  aria-selected={on}
                  disabled={capabilities.security.network === "unavailable"}
                  style={tint ? { ["--setup-chip" as string]: tint } : undefined}
                  onClick={() => setSessionModel(id, defaultModel(id).id)}
                >
                  <span className="setup-provider-dot" aria-hidden="true" />
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
                aria-selected={session.customBotId === bot.id}
                style={{ ["--setup-chip" as string]: bot.color }}
                onClick={() => setSessionModel("custom", bot.model, bot.id)}
              >
                <span className="setup-provider-dot" aria-hidden="true" />
                {bot.name}
              </button>
            ))}
          </div>
        </div>

        <div className="setup-subgroup">
          <div className="section-label">Available models</div>
          <div className="setup-effort setup-models" role="listbox" aria-label="Model">
            {modelsFor(session.provider).map((model) => {
              const on = session.model === model.id;
              return (
                <button
                  key={model.id}
                  className={on ? "on" : undefined}
                  type="button"
                  aria-selected={on}
                  onClick={() => setSessionModel(session.provider, model.id)}
                >
                  <strong>{model.name}</strong>
                  <span>{formatWindow(model.contextWindow)}</span>
                </button>
              );
            })}
          </div>
        </div>
        </section>

        <div className="setup-compact-stack">
          <section className="setup-card setup-environment-card">
        <div className="setup-heading compact">
          <div>
            <strong>Runs on this Mac</strong>
            <span>Choose the working copy used by this chat.</span>
          </div>
        </div>
        <div className="setup-environments" role="listbox" aria-label="Environment">
          <button
            className={environmentKind === "local" ? "on" : undefined}
            type="button"
            aria-selected={environmentKind === "local"}
            disabled={environmentBusy !== null}
            onClick={() => void chooseEnvironment("local")}
          >
            <span className="setup-environment-icon" aria-hidden="true">⌂</span>
            <span><strong>{environmentBusy === "local" ? "Opening…" : "Local folder"}</strong><em>Use the project’s linked files directly.</em></span>
          </button>
          <button
            className={environmentKind === "worktree" ? "on" : undefined}
            type="button"
            aria-selected={environmentKind === "worktree"}
            disabled={!localRoot || environmentBusy !== null}
            title={localRoot ? "Create an isolated Git worktree for this chat" : "Link a project folder first"}
            onClick={() => void chooseEnvironment("worktree")}
          >
            <span className="setup-environment-icon" aria-hidden="true">⑂</span>
            <span><strong>{environmentBusy === "worktree" ? "Creating…" : "Isolated worktree"}</strong><em>Give this chat its own Git working copy.</em></span>
          </button>
        </div>
        <p className="setup-note">
          {environmentNote ||
            (environmentKind === "worktree" && session.environment?.kind === "worktree"
              ? session.environment.path
              : localRoot || "Link a project folder to enable local and worktree choices.")}
        </p>
          </section>

          {thinking.length > 0 && (
            <section className="setup-card setup-reasoning-card">
          <div className="setup-heading compact">
            <div>
              <strong>Reasoning level</strong>
              <span>Control how deeply this model thinks before answering.</span>
            </div>
            <span className="setup-current">{thinkNow?.label}</span>
          </div>
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
        </div>
      </div>

      <section className="setup-card setup-access-card">
        <div className="setup-heading">
          <div>
            <strong>Access &amp; approvals</strong>
            <span>Approval behavior and file containment are separate controls.</span>
          </div>
          <span className="setup-current">{selectedPermission.label} · {selectedSandbox.label}</span>
        </div>
        <div className="setup-split">
          <div className="setup-block">
            <div className="setup-choice-title">
              <strong>Approval behavior</strong>
              <span>When should Workhorse pause?</span>
            </div>
            <div className="setup-grid">
              {PERMISSIONS.map((item) => (
                <button
                  key={item.id}
                  className={session.mode === item.id ? "on" : undefined}
                  type="button"
                  disabled={capabilities.security.network === "unavailable"}
                  onClick={() => setMode(item.id)}
                >
                  <span className="setup-choice-icon" aria-hidden="true">{PERMISSION_ICONS[item.id]}</span>
                  <span className="setup-choice-copy"><strong>{item.label}</strong><em>{item.hint}</em></span>
                </button>
              ))}
            </div>
          </div>

          <div className="setup-block">
            <div className="setup-choice-title">
              <strong>File access</strong>
              <span>How far can tools reach?</span>
            </div>
            <div className="setup-grid">
              {SANDBOXES.map((item) => (
                <button
                  key={item.id}
                  className={session.sandbox === item.id ? "on" : undefined}
                  type="button"
                  onClick={() => setSandbox(item.id)}
                >
                  <span className="setup-choice-icon" aria-hidden="true">{SANDBOX_ICONS[item.id]}</span>
                  <span className="setup-choice-copy"><strong>{item.label}</strong><em>{item.hint}</em></span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="setup-access-note">
          <span aria-hidden="true">i</span>
          <p><strong>Plan mode never edits.</strong> Full access means the sandbox is off; approval rules still apply independently.</p>
        </div>
      </section>

    </div>
  );
}

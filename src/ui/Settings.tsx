import { useEffect, useState } from "react";
import { BOT_COLORS, customBotEnabled } from "../lib/custom-bots";
import { formatWindow, modelsFor } from "../lib/models";
import { PROVIDERS } from "../lib/providers";
import { vendorEnabled, vendorLabel, vendorTint } from "../lib/settings";
import { APP_VERSION } from "../lib/app-info";
import { useStore } from "../lib/store";
import { SETTINGS_THEME_CHOICES } from "../lib/theme";
import type { DeskExportKind, LlmLink, ProviderId, SettingsSection } from "../lib/types";
import { BotForm } from "./BotForm";
import { ContextMeter } from "./ContextMeter";
import { SkillsPane } from "./SkillsPane";
import { UsagePane } from "./UsagePane";
import { WatchPane } from "./WatchPane";
import { RoutingPane } from "./RoutingPane";
import { LearningPane } from "./LearningPane";
import { ProfileHorse } from "./ProfileHorse";
import { routingProfileForModel } from "../lib/routing";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "llms", label: "LLMs" },
  { id: "skills", label: "Skills" },
  { id: "routing", label: "Routing" },
  { id: "learning", label: "Learning" },
  { id: "usage", label: "Usage" },
  { id: "watch", label: "Watch" },
];

const DESK_STOCK: Exclude<ProviderId, "custom">[] = ["grok", "codex", "claude", "cursor"];

function llmCardHint(id: Exclude<ProviderId, "custom">, link: LlmLink): string {
  if (!vendorEnabled(link)) return "Disabled";
  // Installed but signed out is a different problem from missing, and the
  // only one the person can fix from here.
  if (link.needsAuth && !link.connected) return "Needs auth";
  if (link.available === false) return "Not found";
  if (id === "grok" || id === "codex" || id === "claude" || id === "cursor") return "Local login";
  return "Marked";
}

function llmDetailCopy(id: Exclude<ProviderId, "custom">, link: LlmLink): string {
  if (link.connected && link.enabled === false) {
    return "Disabled for new chats.";
  }
  const found = link.available ?? link.connected;
  if (id === "grok") {
    return found ? "Local Grok ready." : "Grok not found.";
  }
  if (id === "codex") {
    return found
      ? "Local Codex ready."
      : "Codex not found.";
  }
  if (id === "claude") {
    return found
      ? "Local Claude ready."
      : "Claude not found.";
  }
  if (id === "cursor") {
    if (link.needsAuth && !link.connected) return "Cursor Agent is installed. Sign in with agent login, then Recheck.";
    return found || link.connected ? "Local Cursor Agent ready." : "Cursor ACP binary or login not found.";
  }
  return found ? "Marked for a future adapter" : "Not connected";
}

type LlmFocus = Exclude<ProviderId, "custom"> | `bot:${string}` | null;

export function Settings() {
  const store = useStore();
  const settings = store.settings;
  const section = store.settingsSection;
  const [llmFocus, setLlmFocus] = useState<LlmFocus>(null);
  const [authMessage, setAuthMessage] = useState("");

  /**
   * Mint a token for this desk with `claude setup-token`. Signing in the
   * ordinary way writes the one credential store Claude Code itself reads,
   * which signs the person out there; a token of our own lets both run.
   */
  const startClaudeAuth = () => {
    void (async () => {
      const run = window.workhorse?.claudeSetupToken;
      if (!run) return;
      setAuthMessage("Signing in. Finish in your browser.");
      const result = await run();
      setAuthMessage(result.ok ? "" : result.message || "Sign-in failed.");
      store.refreshClaudeLogin();
    })();
  };

  useEffect(() => {
    if (section === "llms") store.refreshCursorLogin();
  }, [section, store.refreshCursorLogin]);

  const [usageTick, setUsageTick] = useState(0);
  const [usageHome, setUsageHome] = useState(0);
  const [supportNote, setSupportNote] = useState("");
  const [updateNote, setUpdateNote] = useState("");
  const [updateChecking, setUpdateChecking] = useState(false);

  const openSection = (id: SettingsSection) => {
    if (id === "usage") {
      if (section !== "usage") setUsageTick((tick) => tick + 1);
      else setUsageHome((tick) => tick + 1);
    }
    store.setSettingsSection(id);
  };

  // The window title already reads Settings; the pane does not repeat it. One
  // row holds the tabs and Back, and it is the same row on every tab so
  // switching never shifts the page. Usage draws it itself because its Back
  // first steps out of a drilled-in view.
  const tabs = (
    <div className="actions" role="tablist" aria-label="Settings">
      {SECTIONS.map((item) => (
        <button
          key={item.id}
          className={section === item.id ? "tiny active-kind" : "tiny"}
          type="button"
          role="tab"
          aria-selected={section === item.id}
          onClick={() => openSection(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  return (
    <section className={`picker project-home settings settings-full${section === "usage" ? " usage-section" : ""}`}>
      {section !== "usage" && (
        <div className="settings-bar">
          {tabs}
          <button className="tiny" type="button" onClick={store.closeSettings}>
            Back
          </button>
        </div>
      )}

      {section === "profile" && (
        <>
          <ProfileHorse />
          <div className="settings-group">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>Display name</strong>
              </div>
              <div className="settings-control">
                <input
                  value={settings.profile.name}
                  placeholder="Your name"
                  onChange={(event) => store.updateProfile({ name: event.target.value })}
                />
              </div>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>Handle</strong>
              </div>
              <div className="settings-control">
                <input
                  value={settings.profile.handle}
                  placeholder="@you"
                  onChange={(event) => store.updateProfile({ handle: event.target.value })}
                />
              </div>
            </label>
          </div>
          <div className="settings-group">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>Appearance</strong>
              </div>
              <div className="settings-control">
                <div className="actions" role="radiogroup" aria-label="Appearance">
                  {SETTINGS_THEME_CHOICES.map((item) => (
                    <button
                      key={item.id}
                      className={store.theme === item.id ? "tiny active-kind" : "tiny"}
                      type="button"
                      role="radio"
                      aria-checked={store.theme === item.id}
                      onClick={() => store.setTheme(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>Updates</strong>
                <span>
                  {store.appUpdateBusy
                    ? `Installing Workhorse ${store.appUpdate?.version ?? ""}`.trim()
                    : store.appUpdateError
                      ? store.appUpdateError
                      : updateNote || `Workhorse build v${APP_VERSION}`}
                </span>
              </div>
              <div className="settings-control">
                <button
                  className="tiny"
                  type="button"
                  disabled={updateChecking || store.appUpdateBusy}
                  onClick={() => {
                    void (async () => {
                      setUpdateChecking(true);
                      setUpdateNote("Checking…");
                      const result = await store.checkAppUpdate({ reveal: true });
                      setUpdateChecking(false);
                      if (result.error) setUpdateNote(result.error);
                      else if (result.offer) setUpdateNote(`Workhorse ${result.offer.version} is ready.`);
                      else setUpdateNote("This is the latest build.");
                    })();
                  }}
                >
                  {updateChecking ? "Checking…" : "Check now"}
                </button>
                {store.appUpdate ? (
                  <button
                    className="tiny"
                    type="button"
                    disabled={store.appUpdateBusy}
                    onClick={() => void store.applyAppUpdate(store.appUpdate?.version)}
                  >
                    {store.appUpdateBusy ? "Installing…" : `Install ${store.appUpdate.version}`}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>Diagnostics</strong>
                <span>{supportNote || "A support report. Private data excluded."}</span>
              </div>
              <div className="settings-control">
                <button className="tiny" type="button" onClick={() => {
                  void window.workhorse?.exportDiagnostics?.().then((result) => {
                    if (!result || result.canceled) return;
                    setSupportNote(result.ok ? `Saved to ${result.path}` : "Could not export support information.");
                  });
                }}>
                  Export
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {section === "llms" && (
        <>
          <div className="usage-brains llm-brains">
            {DESK_STOCK.filter((id) => settings.llms[id].connected).map((id) => {
              const link = settings.llms[id];
              const live = vendorEnabled(link);
              const tint = vendorTint(id, link);
              const name = vendorLabel(id, link);
              return (
                <div
                  key={id}
                  className={`usage-brain${llmFocus === id ? " on" : ""}${live ? "" : " off"}`}
                >
                  <button
                    type="button"
                    className={`llm-mark ${id}${live ? " on" : ""}`}
                    style={live && tint ? { borderColor: tint, color: "var(--text)" } : undefined}
                    aria-pressed={live}
                    aria-label={live ? `Disable ${name}` : `Enable ${name}`}
                    onClick={() => store.setLlmEnabled(id, !live)}
                  >
                    {live ? "On" : "Off"}
                  </button>
                  <button
                    type="button"
                    className="llm-brain-open"
                    onClick={() => setLlmFocus((current) => (current === id ? null : id))}
                  >
                    <span>{name}</span>
                    <em>{llmCardHint(id, link)}</em>
                  </button>
                  {id === "claude" && link.needsAuth ? (
                    <button type="button" className="tiny" onClick={startClaudeAuth}>
                      Log in
                    </button>
                  ) : null}
                </div>
              );
            })}
            {settings.customBots.map((bot) => {
              const live = customBotEnabled(bot);
              return (
                <div
                  key={bot.id}
                  className={`usage-brain${llmFocus === `bot:${bot.id}` ? " on" : ""}${live ? "" : " off"}`}
                >
                  <button
                    type="button"
                    className={`llm-mark${live ? " on" : ""}`}
                    style={live ? { borderColor: bot.color, color: "var(--text)" } : undefined}
                    aria-pressed={live}
                    aria-label={live ? `Disable ${bot.name}` : `Enable ${bot.name}`}
                    onClick={() => store.setCustomBotEnabled(bot.id, !live)}
                  >
                    {live ? "On" : "Off"}
                  </button>
                  <button
                    type="button"
                    className="llm-brain-open"
                    onClick={() => setLlmFocus((current) => (current === `bot:${bot.id}` ? null : `bot:${bot.id}`))}
                  >
                    <span>{bot.name}</span>
                    <em>{live ? bot.model : "Disabled"}</em>
                  </button>
                </div>
              );
            })}
            <button className="usage-brain add" type="button" onClick={store.openAddBot}>
              <span className="llm-mark plus" aria-hidden="true">
                +
              </span>
              <span>Add bot</span>
              <em>Grok, Codex, Claude, Cursor</em>
            </button>
          </div>

          {llmFocus && !String(llmFocus).startsWith("bot:") && (
            <StockBotDetail
              id={llmFocus as Exclude<ProviderId, "custom">}
              onGone={() => setLlmFocus(null)}
              onStartAuth={startClaudeAuth}
            />
          )}

          {authMessage ? <p className="row-meta">{authMessage}</p> : null}


          {typeof llmFocus === "string" && llmFocus.startsWith("bot:") && (
            <CustomBotDetail key={llmFocus} botId={llmFocus.slice(4)} onGone={() => setLlmFocus(null)} />
          )}

          <AgentSystemsBlock />
        </>
      )}

      {section === "skills" && <SkillsPane />}

      {section === "routing" && <RoutingPane />}

      {section === "learning" && <LearningPane />}

      {section === "usage" && <UsagePane key={usageTick} homeSignal={usageHome} embedded tabs={tabs} />}

      {section === "watch" && <WatchPane />}
    </section>
  );
}

function StockBotDetail({
  id,
  onGone,
  onStartAuth,
}: {
  id: Exclude<ProviderId, "custom">;
  onGone: () => void;
  onStartAuth: () => void;
}) {
  const store = useStore();
  const link = store.settings.llms[id];
  const live = vendorEnabled(link);
  const name = vendorLabel(id, link);
  const tint = vendorTint(id, link);
  return (
    <div className="link-block llm-detail bot-edit">
      <div className="link-head">
        <strong>{name}</strong>
        <div className="actions llm-detail-actions">
          <button
            className="tiny"
            type="button"
            onClick={() =>
              id === "grok"
                ? store.refreshGrokLogin()
                : id === "codex"
                  ? store.refreshCodexLogin()
                  : id === "cursor"
                    ? store.refreshCursorLogin()
                    : store.refreshClaudeLogin()
            }
          >
            Recheck
          </button>
          <button className="tiny" type="button" onClick={() => store.setLlmEnabled(id, link.enabled === false)}>
            {link.enabled === false ? "Enable" : "Disable"}
          </button>
          <button
            className="tiny"
            type="button"
            onClick={() => {
              store.setLlmConnected(id, false);
              onGone();
            }}
          >
            Delete
          </button>
        </div>
      </div>

      <div className="add-bot-preview" aria-hidden="true">
        <span
          className={`llm-mark ${id}${live ? " on" : ""}`}
          style={live && tint ? { borderColor: tint } : undefined}
        >
          {live ? "On" : "Off"}
        </span>
        <div>
          <strong>{name}</strong>
          <em>{llmCardHint(id, link)}</em>
        </div>
      </div>

      {id === "claude" && link.needsAuth ? (
        <button type="button" className="ghost" onClick={onStartAuth}>
          Log in with Claude
        </button>
      ) : null}

      <BotForm
        identityOnly
        defaultColor={`var(--${id})`}
        namePlaceholder={PROVIDERS.find((item) => item.id === id)?.name}
        value={{ name: link.name ?? "", color: tint ?? "" }}
        onChange={(patch) => store.updateLlmLink(id, patch)}
      />

      <div className="bot-context-row">
        <ContextMeter fallbackWindow={modelsFor(id)[0]?.contextWindow} matchProvider={id} />
        <p className="row-meta">{llmDetailCopy(id, link)}</p>
      </div>
      {id === "codex" ? <CodexNativeStatus /> : null}
      <MassSend vendor={id} />
    </div>
  );
}

function BotRoutingFields({ bot }: { bot: import("../lib/types").CustomBot }) {
  const store = useStore();
  const current = routingProfileForModel("custom", bot.model, bot.routingProfile);
  const setRole = (role: string) => {
    const values = role === "deep"
      ? { intelligence: 5, speed: 2, cost: 5 }
      : role === "quick"
        ? { intelligence: 3, speed: 5, cost: 1 }
        : { intelligence: 4, speed: 4, cost: 3 };
    store.updateCustomBot(bot.id, { routingProfile: { ...current, ...values } });
  };
  const role = current.intelligence >= 5 ? "deep" : current.speed >= 5 && current.cost <= 2 ? "quick" : "balanced";
  const input = (key: keyof typeof current.inputs, value: boolean) =>
    store.updateCustomBot(bot.id, {
      routingProfile: { ...current, inputs: { ...current.inputs, [key]: value } },
    });
  return (
    <div className="field">
      <span>Routing</span>
      <div className="actions">
        <select value={role} onChange={(event) => setRole(event.target.value)} aria-label="Routing role">
          <option value="quick">Quick</option>
          <option value="balanced">Balanced</option>
          <option value="deep">Deep</option>
        </select>
        <label><input type="checkbox" checked={current.local} onChange={(event) => store.updateCustomBot(bot.id, { routingProfile: { ...current, local: event.target.checked } })} /> Local</label>
      </div>
      <div className="actions">
        <label><input type="checkbox" checked={current.inputs.images} onChange={(event) => input("images", event.target.checked)} /> Images</label>
        <label><input type="checkbox" checked={current.inputs.documents} onChange={(event) => input("documents", event.target.checked)} /> Docs</label>
        <label><input type="checkbox" checked={current.inputs.audio} onChange={(event) => input("audio", event.target.checked)} /> Audio</label>
        <label><input type="checkbox" checked={current.inputs.video} onChange={(event) => input("video", event.target.checked)} /> Video</label>
      </div>
    </div>
  );
}

function CodexNativeStatus() {
  const store = useStore();
  const active = store.sessions.find((session) => session.id === store.activeSessionId);
  const project = store.projects.find((item) => item.id === active?.projectId);
  const projectRoot = project?.folders[0]?.path;
  const [runtime, setRuntime] = useState<import("../../electron/codex-app-server").CodexRuntimeInfo | null>(null);
  const [threads, setThreads] = useState<import("../../electron/codex-app-server").CodexNativeThread[]>([]);
  const [capabilities, setCapabilities] = useState<ReturnType<typeof import("../../electron/codex-capabilities").codexCapabilitySummary> | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([
      window.workhorse?.detectCodexRuntime?.(),
      window.workhorse?.codexCapabilities?.(projectRoot),
    ]).then(async ([nextRuntime, nextCapabilities]) => {
      if (!live) return;
      setRuntime(nextRuntime ?? null);
      setCapabilities(nextCapabilities ?? null);
      if (nextRuntime?.appServer.available && window.workhorse?.listCodexNativeThreads) {
        const rows = await window.workhorse.listCodexNativeThreads(8).catch(() => []);
        if (live) setThreads(rows);
      }
    });
    return () => { live = false; };
  }, [projectRoot]);

  const runtimeLabel = !runtime
    ? "Checking Codex runtime…"
    : runtime.preferred === "app-server"
      ? "App Server · native history and events"
      : runtime.preferred === "acp"
        ? "ACP fallback · prompt transport only"
        : "Codex runtime unavailable";
  return (
    <div className="codex-native-status">
      <div className="link-head">
        <span className="section-label">Native Codex</span>
        <span className="row-meta">{runtimeLabel}</span>
      </div>
      <div className="codex-capability-grid">
        <span><strong>Threads</strong>{runtime?.appServer.available ? `${threads.length} recent loaded` : "Needs App Server"}</span>
        <span><strong>Subagents</strong>{threads.some((thread) => thread.parentThreadId) ? "Child threads found" : capabilities?.nativeSubagents.message ?? "Checking…"}</span>
        <span><strong>Hooks</strong>{capabilities ? `${capabilities.hooks.length} source${capabilities.hooks.length === 1 ? "" : "s"}` : "Checking…"}</span>
        <span><strong>Cloud</strong>{capabilities?.cloudEnvironments.available ? "Available" : "Not exposed locally"}</span>
      </div>
      {threads.length > 0 ? (
        <ul className="codex-thread-list">
          {threads.slice(0, 5).map((thread) => (
            <li key={thread.id}>
              <strong>{thread.name || thread.id}</strong>
              <span>{thread.parentThreadId ? "Subagent" : thread.status || "Thread"}{thread.cwd ? ` · ${thread.cwd}` : ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {capabilities?.hooks.length ? (
        <p className="row-meta" title={capabilities.hooks.map((hook) => hook.path).join("\n")}>
          Hooks: {capabilities.hooks.map((hook) => `${hook.scope} ${hook.kind}`).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function MassSend({
  vendor,
  customBotId,
  botName,
}: {
  vendor: ProviderId;
  customBotId?: string;
  botName?: string;
}) {
  const store = useStore();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<DeskExportKind | null>(null);

  const send = (kind: DeskExportKind) => {
    setBusy(kind);
    setNote("");
    void store.massSendVendor(vendor, kind, { customBotId, botName }).then((result) => {
      setBusy(null);
      if (result.canceled) {
        setNote("Canceled.");
        return;
      }
      if (!result.ok) {
        setNote(result.message || "Could not send.");
        return;
      }
      if (kind === "skills") {
        setNote(`${result.skills ?? 0} skill${result.skills === 1 ? "" : "s"} sent to Desktop / Workhorse exports.`);
      } else {
        setNote(`${result.chats ?? 0} chat${result.chats === 1 ? "" : "s"} sent to Desktop / Workhorse exports.`);
      }
    });
  };

  return (
    <div className="mass-send">
      <div className="section-label">Mass send</div>
      <div className="actions">
        <button className="tiny" type="button" disabled={busy !== null} onClick={() => send("skills")}>
          {busy === "skills" ? "Sending…" : "Skills"}
        </button>
        <button className="tiny" type="button" disabled={busy !== null} onClick={() => send("chats")}>
          {busy === "chats" ? "Sending…" : "Projects / chats"}
        </button>
      </div>
      {note ? <p className="row-meta">{note}</p> : null}
    </div>
  );
}

function CustomBotDetail({ botId, onGone }: { botId: string; onGone: () => void }) {
  const store = useStore();
  const bot = store.settings.customBots.find((item) => item.id === botId);
  const [probeNote, setProbeNote] = useState("");
  const [probing, setProbing] = useState(false);
  if (!bot) return null;
  const live = customBotEnabled(bot);
  return (
    <div className="link-block llm-detail bot-edit">
      <div className="link-head">
        <strong>{bot.name.trim() || "Untitled"}</strong>
        <div className="actions llm-detail-actions">
          <button className="tiny" type="button" onClick={() => store.setCustomBotEnabled(bot.id, !live)}>
            {live ? "Disable" : "Enable"}
          </button>
          <button
            className="tiny"
            type="button"
            onClick={() => {
              store.deleteCustomBot(bot.id);
              onGone();
            }}
          >
            Delete
          </button>
        </div>
      </div>

      <div className="add-bot-preview" aria-hidden="true">
        <span
          className={`llm-mark${live ? " on" : ""}`}
          style={live ? { borderColor: bot.color || BOT_COLORS[0].value } : undefined}
        >
          {live ? "On" : "Off"}
        </span>
        <div>
          <strong>{bot.name.trim() || "Untitled"}</strong>
          <em>{bot.model.trim() || "No model yet"}</em>
        </div>
      </div>

      <BotForm
        value={{
          name: bot.name,
          color: bot.color || BOT_COLORS[0].value,
          model: bot.model,
          baseUrl: bot.baseUrl,
          apiKey: bot.apiKey,
          contextWindow: bot.contextWindow,
          models: bot.models,
          discovered: bot.discovered,
        }}
        onChange={(patch) => {
          setProbeNote("");
          store.updateCustomBot(bot.id, patch);
        }}
      />

      <BotRoutingFields bot={bot} />

      <div className="bot-context-row">
        <ContextMeter fallbackWindow={bot.contextWindow} matchProvider="custom" matchBotId={bot.id} />
        <p className="row-meta">
          {probing
            ? "Testing API…"
            : probeNote ||
              `${bot.api === "openai-completions" ? "OpenAI" : "Anthropic"} HTTP · ${formatWindow(bot.contextWindow)} context`}
        </p>
      </div>
      <div className="actions add-bot-actions">
        <button
          className="tiny"
          type="button"
          disabled={probing}
          onClick={() => {
            setProbing(true);
            void store.probeCustomBot(bot.id).then((result) => {
              setProbeNote(result.message);
              setProbing(false);
            });
          }}
        >
          Test API
        </button>
      </div>
      <MassSend vendor="custom" customBotId={bot.id} botName={bot.name} />
    </div>
  );
}

function flagCopy(on: boolean, label: string): string {
  return on ? label : `Not ${label.toLowerCase()}`;
}

function AgentSystemsBlock() {
  const store = useStore();
  const [note, setNote] = useState("");
  useEffect(() => {
    void store.refreshAgentRuntimes();
  }, []);
  const chats = store.sessions.filter((session) => !session.hidden && !session.archivedAt);
  return (
    <div className="settings-group">
      <div className="settings-row">
        <div className="settings-row-copy">
          <strong>Agent systems</strong>
          <span>
            OpenClaw and Hermes are installed runtimes, not vendors. Install MCP writes this desk into OpenClaw, and
            into Hermes if it is already installed. They launch the packaged helper. No token is stored.
          </span>
        </div>
        <div className="settings-control">
          <button className="tiny" type="button" onClick={() => void store.refreshAgentRuntimes()}>
            Recheck
          </button>
          <button
            className="tiny"
            type="button"
            onClick={() => {
              void store.installExternalMcp().then((result) => {
                setNote(
                  result.message ||
                    (result.ok
                      ? "Wrote the Workhorse MCP into OpenClaw and Hermes. They launch this app’s helper. No token stored."
                      : "Could not install."),
                );
              });
            }}
          >
            Install MCP
          </button>
        </div>
      </div>
      {(store.agentRuntimes.length ? store.agentRuntimes : [
        { runtimeId: "openclaw" as const, binaryPresent: false, configPresent: false, authenticated: false, reachable: false },
        { runtimeId: "hermes" as const, binaryPresent: false, configPresent: false, authenticated: false, reachable: false },
      ]).map((runtime) => (
        <p key={runtime.runtimeId} className="row-meta">
          {runtime.runtimeId === "openclaw" ? "OpenClaw" : "Hermes"} · {flagCopy(runtime.binaryPresent, "binary")} ·{" "}
          {flagCopy(runtime.configPresent, "config")}
          {runtime.version ? ` · ${runtime.version}` : ""} · {flagCopy(runtime.authenticated, "authenticated")} ·{" "}
          {flagCopy(runtime.reachable, "reachable")}
        </p>
      ))}
      {store.agentCatalog.length > 0 ? (
        <p className="row-meta">Agents: {store.agentCatalog.map((agent) => agent.name).join(", ")}</p>
      ) : (
        <p className="row-meta">No agents discovered.</p>
      )}
      <label className="settings-row">
        <div className="settings-row-copy">
          <strong>Inbound parent</strong>
          <span>OpenClaw and Hermes spawn Workhorse workers on this chat. Empty rejects spawn with context_required.</span>
        </div>
        <div className="settings-control">
          <select
            value={store.settings.agentSystems?.inboundSessionId ?? ""}
            onChange={(event) => store.updateAgentSystems({ inboundSessionId: event.target.value || undefined })}
            aria-label="Inbound parent chat"
          >
            <option value="">None</option>
            {chats.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title || session.id}
              </option>
            ))}
          </select>
        </div>
      </label>
      {note ? <p className="row-meta">{note}</p> : null}
    </div>
  );
}

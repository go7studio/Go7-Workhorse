import { primaryFolder } from "../lib/project";
import { useEffect, useState } from "react";
import { LINK_HOSTS, LINK_HOST_LABEL, linkHostConnectsByOneshot } from "../lib/workhorse-link";
import { BOT_COLORS, customBotEnabled, customBotModels, customModelRoutingOverride, routingProfileEdit, ROUTING_ROLE_PRESETS } from "../lib/custom-bots";
import { isGrokBotUrl } from "../lib/custom-http-identity";
import { formatWindow, modelsFor } from "../lib/models";
import { PROVIDERS } from "../lib/providers";
import { agentSystemsFromInboundSelect, inboundParentSelectValue, vendorEnabled, vendorLabel, vendorTint } from "../lib/settings";
import { llmCardHint, llmDetailCopy } from "../lib/llm-copy";
import { claudeTokenComplaint, CLAUDE_SETUP_TOKEN_COMMAND } from "../lib/claude-token";
import { APP_VERSION } from "../lib/app-info";
import { useStore } from "../lib/store";
import { SETTINGS_THEME_CHOICES } from "../lib/theme";
import type { AgentRuntimeId, DeskExportKind, LlmLink, PermissionMode, ProviderId, SandboxProfile, SettingsSection } from "../lib/types";
import type { AgentRuntimeStatus } from "../lib/external-catalog";
import { BotForm } from "./BotForm";
import { ContextMeter } from "./ContextMeter";
import { SkillsPane } from "./SkillsPane";
import { WorkshopBlock } from "./WorkshopBlock";
import { UsagePane } from "./UsagePane";
import { WatchPane } from "./WatchPane";
import { RoutingPane } from "./RoutingPane";
import { LearningPane } from "./LearningPane";
import { ProfileHorse } from "./ProfileHorse";
import { routingProfileForModel } from "../lib/routing";
import { formatExternalAgentRef } from "../lib/agent-runtime";
import { LocalComputeBlock } from "./LocalComputeBlock";
import { GrokBotWakeSetup } from "./GrokBotWakeSetup";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "llms", label: "LLMs" },
  { id: "skills", label: "Skills" },
  { id: "workshop", label: "Workshop" },
  { id: "routing", label: "Routing" },
  { id: "learning", label: "Learning" },
  { id: "usage", label: "Usage" },
  { id: "watch", label: "Watch" },
];

const DESK_STOCK: Exclude<ProviderId, "custom">[] = ["grok", "codex", "claude", "cursor"];

type LlmFocus = Exclude<ProviderId, "custom"> | `bot:${string}` | null;

export function Settings() {
  const store = useStore();
  const settings = store.settings;
  const section = store.settingsSection;
  const [llmFocus, setLlmFocus] = useState<LlmFocus>(null);
  const [claudeAuth, setClaudeAuth] = useState<ClaudeAuthState>({ stage: "idle", message: "" });

  /**
   * Mint a token for this desk with `claude setup-token`. Signing in the
   * ordinary way writes the one credential store Claude Code itself reads,
   * which signs the person out there; a token of our own lets both run.
   *
   * The desk runs it under a pseudo-terminal, because that command is a
   * terminal program: without one it prints nothing and waits. When this desk
   * cannot make a terminal the card says so and takes a pasted token instead.
   */
  const startClaudeAuth = () => {
    void (async () => {
      const run = window.workhorse?.claudeSetupToken;
      if (!run) return;
      setClaudeAuth({ stage: "running", message: "Approve the sign-in in your browser." });
      const result = await run().catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : "Sign-in failed.",
        reason: undefined,
      }));
      if (result.ok) {
        setClaudeAuth({ stage: "done", message: "Signed in." });
      } else if (result.reason === "needs_terminal") {
        setClaudeAuth({ stage: "paste", message: result.message || "", token: "" });
      } else {
        setClaudeAuth({ stage: "idle", message: result.message || "Sign-in failed." });
      }
      store.refreshClaudeLogin();
    })();
  };

  const saveClaudeToken = (token: string) => {
    void (async () => {
      const keep = window.workhorse?.claudeStoreToken;
      const complaint = claudeTokenComplaint(token);
      if (complaint) {
        setClaudeAuth((current) => ({ ...current, stage: "paste", message: complaint, token }));
        return;
      }
      if (!keep) return;
      setClaudeAuth((current) => ({ ...current, stage: "paste", message: "Saving…", token }));
      const result = await keep(token).catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : "Could not store the token.",
      }));
      setClaudeAuth(
        result.ok
          ? { stage: "done", message: "Signed in." }
          : { stage: "paste", message: result.message || "Could not store the token.", token },
      );
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
                <span>{supportNote || "Export a private-data-free support report."}</span>
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
                    <button
                      type="button"
                      className="tiny"
                      disabled={claudeAuth.stage === "running"}
                      onClick={() => {
                        // Open the card as the flow starts: this button is on
                        // the grid, and everything the flow has to say — the
                        // progress, the reason, the paste field — is inside.
                        setLlmFocus("claude");
                        startClaudeAuth();
                      }}
                    >
                      {claudeAuth.stage === "running" ? "Signing in…" : "Log in"}
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
                    <em>
                      {live && isGrokBotUrl(bot.baseUrl) && !store.grokBotWakeStatus?.ready
                        ? "Finish instant chat"
                        : live
                          ? bot.model
                          : "Disabled"}
                    </em>
                  </button>
                </div>
              );
            })}
            <button className="usage-brain add" type="button" onClick={store.openAddBot}>
              <span className="llm-mark plus" aria-hidden="true">
                +
              </span>
              <span>Add bot</span>
              <em>Grok Bot, Grok, Codex, Claude, Cursor</em>
            </button>
          </div>

          {llmFocus && !String(llmFocus).startsWith("bot:") && (
            <StockBotDetail
              id={llmFocus as Exclude<ProviderId, "custom">}
              onGone={() => setLlmFocus(null)}
              onStartAuth={startClaudeAuth}
              auth={claudeAuth}
              onAuthToken={saveClaudeToken}
              onAuthTokenChange={(token) => setClaudeAuth((current) => ({ ...current, token }))}
            />
          )}

          {typeof llmFocus === "string" && llmFocus.startsWith("bot:") && (
            <CustomBotDetail key={llmFocus} botId={llmFocus.slice(4)} onGone={() => setLlmFocus(null)} />
          )}

          <DeskAccessBlock />
          <LocalComputeBlock />
          <AgentSystemsBlock />
        </>
      )}

      {section === "skills" && <SkillsPane />}

      {section === "workshop" && <WorkshopBlock />}

      {section === "routing" && <RoutingPane />}

      {section === "learning" && <LearningPane />}

      {section === "usage" && <UsagePane key={usageTick} homeSignal={usageHome} embedded tabs={tabs} />}

      {section === "watch" && <WatchPane />}
    </section>
  );
}

/** What the desk is doing about the Claude login, and what it needs next. */
export type ClaudeAuthState = { stage: "idle" | "running" | "paste" | "done"; message: string; token?: string };

/**
 * The way in to a Claude login, always on the card.
 *
 * It used to appear only when detection said the login was missing, so a desk
 * that had just started — which forgets a refusal — offered no way to sign in
 * until a call failed first. Minting a token is something a person may want at
 * any time, so the control is always here and the state changes only its words.
 */
function ClaudeSignIn({
  link,
  auth,
  onStart,
  onToken,
  onTokenChange,
}: {
  link: LlmLink;
  auth: ClaudeAuthState;
  onStart: () => void;
  onToken: (token: string) => void;
  onTokenChange: (token: string) => void;
}) {
  const running = auth.stage === "running";
  const token = auth.token ?? "";
  return (
    <div className="claude-sign-in">
      <div className="actions">
        <button type="button" className="ghost" onClick={onStart} disabled={running}>
          {running ? "Signing in…" : link.needsAuth ? "Log in with Claude" : "Mint a new token"}
        </button>
        {auth.message ? <span className="row-meta">{auth.message}</span> : null}
      </div>
      {auth.stage === "paste" ? (
        <div className="claude-sign-in-paste">
          <label className="row-meta" htmlFor="claude-token">
            Run this in your terminal, then paste what it prints:
          </label>
          <code>{CLAUDE_SETUP_TOKEN_COMMAND}</code>
          <div className="actions">
            <input
              id="claude-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              value={token}
              onChange={(event) => onTokenChange(event.target.value)}
            />
            <button type="button" className="tiny" onClick={() => onToken(token)} disabled={!token.trim()}>
              Save token
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StockBotDetail({
  id,
  onGone,
  onStartAuth,
  auth,
  onAuthToken,
  onAuthTokenChange,
}: {
  id: Exclude<ProviderId, "custom">;
  onGone: () => void;
  onStartAuth: () => void;
  auth: ClaudeAuthState;
  onAuthToken: (token: string) => void;
  onAuthTokenChange: (token: string) => void;
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
                    : store.refreshClaudeLogin({ recheck: true })
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

      {id === "claude" ? (
        <ClaudeSignIn
          link={link}
          auth={auth}
          onStart={onStartAuth}
          onToken={onAuthToken}
          onTokenChange={onAuthTokenChange}
        />
      ) : null}

      <BotForm
        identityOnly
        defaultColor={`var(--${id})`}
        namePlaceholder={PROVIDERS.find((item) => item.id === id)?.name}
        value={{ name: link.name ?? "", color: tint ?? "" }}
        onChange={(patch) => store.updateLlmLink(id, patch)}
      />

      <div className="bot-context-row">
        <ContextMeter referenceOnly fallbackWindow={modelsFor(id)[0]?.contextWindow} />
        <p className="row-meta">{llmDetailCopy(id, link)}</p>
      </div>
      {id === "codex" ? <CodexNativeStatus /> : null}
      <MassSend vendor={id} />
    </div>
  );
}

/**
 * Ticking a box is not rating a bot.
 *
 * Every handler here used to save `{ ...current, ...one change }`, and `current`
 * is the resolved profile, not the stored one. So a person who only ticked
 * Local or Docs had the family default written back as an override they never
 * authored, on the 1-5 scale, where it stuck. Kimi K3 on this desk ended up
 * rated 3, which doubles to 6 and can never clear the balanced bar of 8: Auto
 * could not send it ordinary coding work, and this pane showed "Balanced".
 *
 * Now each control writes only its own field, over whatever is stored, and the
 * readout says which numbers are the person's and what they score out of 10.
 */
function BotRoutingFields({ bot }: { bot: import("../lib/types").CustomBot }) {
  const store = useStore();
  const saved = bot.routingProfile;
  const current = routingProfileForModel("custom", bot.model, saved);
  const patch = (change: Parameters<typeof routingProfileEdit>[1]) =>
    store.updateCustomBot(bot.id, { routingProfile: routingProfileEdit(saved, change) });
  const setRole = (role: string) =>
    patch(role === "family" ? "family" : ROUTING_ROLE_PRESETS[role as keyof typeof ROUTING_ROLE_PRESETS]);
  const rated = saved?.intelligence !== undefined;
  const role = !rated
    ? "family"
    : current.intelligence >= 9
      ? "deep"
      : current.speed >= 5 && current.cost <= 2
        ? "quick"
        : "balanced";
  // One tick is one key. Spreading `current.inputs` here was the last control
  // still laying its change over the resolved profile: the ratings were fixed
  // and this one was not, so ticking Docs on an unrated bot went on authoring
  // the family's answer for images, audio and video as three overrides nobody
  // chose. Storage stopped inventing keys, but the pane was still supplying
  // them. routingProfileEdit merges the bag, so an earlier tick survives.
  const input = (key: keyof typeof current.inputs, value: boolean) => patch({ inputs: { [key]: value } });
  return (
    <div className="field">
      <span>Routing</span>
      <div className="actions">
        <select value={role} onChange={(event) => setRole(event.target.value)} aria-label="Routing role">
          <option value="family">Family default</option>
          <option value="quick">Quick</option>
          <option value="balanced">Balanced</option>
          <option value="deep">Deep</option>
        </select>
        <label><input type="checkbox" checked={current.local} onChange={(event) => patch({ local: event.target.checked })} /> Local</label>
      </div>
      <p className="row-meta">
        {rated
          ? `Rated ${saved!.intelligence} of 5 · scores ${current.intelligence} of 10`
          : `Family default · scores ${current.intelligence} of 10`}
      </p>
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
  const projectRoot = primaryFolder(project, store.folderExists)?.path;
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

type CustomCatalog = import("../../electron/custom-catalog").CustomCatalog;
type CustomCatalogModel = import("../../electron/custom-catalog").CustomCatalogModel;
type CustomModelTestResult = import("../../electron/custom-http").CustomModelTestResult;
type StoredRoutingProfile = import("../lib/types").StoredRoutingProfile;

/**
 * Which of the editor's three roles a saved per-model override reads as. The
 * presets are the ones the bot's own Routing controls write, so a row and the
 * bot agree about what "Deep" means. An unrated model reads "family": the
 * rating beside it comes from the family table and nothing is stored.
 */
function storedRole(stored?: StoredRoutingProfile): "family" | "quick" | "balanced" | "deep" {
  if (!stored || stored.intelligence === undefined) return "family";
  for (const [role, values] of Object.entries(ROUTING_ROLE_PRESETS)) {
    if (stored.intelligence === values.intelligence && stored.speed === values.speed && stored.cost === values.cost) {
      return role as "quick" | "balanced" | "deep";
    }
  }
  return stored.intelligence >= 5 ? "deep" : (stored.speed ?? 0) >= 5 && (stored.cost ?? 5) <= 2 ? "quick" : "balanced";
}

function priceLabel(model: CustomCatalogModel | undefined): string {
  if (!model) return "";
  const money = (value: number) => (value >= 1 ? value.toFixed(2) : value.toFixed(3));
  const parts: string[] = [];
  if (model.pricePerMTokIn !== undefined) parts.push(`$${money(model.pricePerMTokIn)}/M in`);
  if (model.pricePerMTokOut !== undefined) parts.push(`$${money(model.pricePerMTokOut)}/M out`);
  return parts.join(" · ");
}

function testLabel(result: CustomModelTestResult): string {
  if (!result.ok) return result.message;
  const counts =
    result.inputTokens !== undefined || result.outputTokens !== undefined
      ? ` · ${result.inputTokens ?? 0} in / ${result.outputTokens ?? 0} out`
      : "";
  return `${result.reply ?? result.message} · ${result.latencyMs} ms${counts}`;
}

/**
 * What the host serves, what this bot offers, and what Auto will think of each.
 *
 * A multi-model host sells dozens behind one key. Typing the ids by hand made
 * every one of them a guess — the right spelling, the real window, the price —
 * and a wrong guess is only found when a chat fails. So the list comes from the
 * host, the windows and prices are the host's own numbers, and each row can be
 * tested on its own before anyone routes work to it.
 *
 * Nothing is written on open. A catalog arriving does not approve a model, and
 * the rating shown beside a row is the effective one from the family table
 * until the person deliberately overrides it. Only a tick, a role change or a
 * test button writes anything.
 */
function OfferedModels({ bot }: { bot: import("../lib/types").CustomBot }) {
  const store = useStore();
  const [catalog, setCatalog] = useState<CustomCatalog | null | undefined>(undefined);
  const [tests, setTests] = useState<Record<string, CustomModelTestResult | "busy">>({});
  const { id: botId, baseUrl } = bot;
  // A bot that is off is off. Opening its editor must not reach its host or
  // spend its key, so the section reads back what it already offers and asks
  // nothing. Turning the bot on is what asks.
  const live = customBotEnabled(bot);

  useEffect(() => {
    let alive = true;
    setCatalog(undefined);
    if (!live || !window.workhorse?.customBotCatalog) {
      setCatalog(null);
      return () => {
        alive = false;
      };
    }
    void window.workhorse
      .customBotCatalog(botId)
      .then((next) => {
        if (!alive) return;
        setCatalog(next);
        // A window the host published beats the one saved on the bot, and the
        // chat picker reads it from the desk catalog rather than from here.
        if (next) store.refreshVendorModels();
      })
      .catch(() => {
        if (alive) setCatalog(null);
      });
    return () => {
      alive = false;
    };
  }, [botId, baseUrl, live, store]);

  const primary = bot.model.trim();
  const approved = new Set(bot.models ?? []);
  const listed = catalog?.models ?? [];
  // With no catalog to draw from, an off bot still shows what it already
  // offers, so the person can see what turning it back on would put in play.
  const rows = live
    ? [primary, ...listed.map((model) => model.id).filter((id) => id !== primary)].filter(Boolean)
    : customBotModels(bot);
  const byId = new Map(listed.map((model) => [model.id, model]));

  const toggle = (id: string) => {
    const next = new Set(approved);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    store.updateCustomBot(bot.id, { models: [...next].filter((item) => item !== primary) });
  };

  const setRole = (id: string, role: string) => {
    const next = { ...(bot.routingProfiles ?? {}) };
    const edited = routingProfileEdit(
      bot.routingProfiles?.[id],
      role === "family" ? "family" : ROUTING_ROLE_PRESETS[role as keyof typeof ROUTING_ROLE_PRESETS],
    );
    if (edited) next[id] = edited;
    else delete next[id];
    store.updateCustomBot(bot.id, { routingProfiles: next });
  };

  const runTest = (id: string) => {
    if (!window.workhorse?.testCustomBotModel) return;
    setTests((current) => ({ ...current, [id]: "busy" }));
    void window.workhorse
      .testCustomBotModel(bot.id, id)
      .then((result) => setTests((current) => ({ ...current, [id]: result })))
      .catch((error: unknown) =>
        setTests((current) => ({
          ...current,
          [id]: {
            ok: false,
            model: id,
            latencyMs: 0,
            message: error instanceof Error ? error.message : "The test could not run.",
          },
        })),
      );
  };

  return (
    <div className="field wide bot-offered">
      <span>Offered models</span>
      {!live ? (
        <p className="row-meta">
          This bot is off, so its host is not asked and its models cannot be tested. Turn it on to pick and test what
          it serves.
        </p>
      ) : catalog === undefined ? (
        <p className="row-meta">Asking the host what it serves…</p>
      ) : catalog === null ? (
        <p className="row-meta">
          This host does not publish a model list. Add the ids you want by hand under “Models on this key” above.
        </p>
      ) : (
        <p className="row-meta">
          {listed.length} model{listed.length === 1 ? "" : "s"} on this host. Tick the ones this bot may offer; every
          ticked model becomes a routing candidate.
        </p>
      )}
      {catalog || !live
        ? rows.map((id) => {
            const model = byId.get(id);
            const isPrimary = id === primary;
            const on = isPrimary || approved.has(id);
            const effective = routingProfileForModel("custom", id, customModelRoutingOverride(bot, id));
            const result = tests[id];
            return (
              <div className="bot-offered-row" key={id}>
                <label className="bot-offered-pick">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={isPrimary || !live}
                    title={isPrimary ? "The bot's own model is always offered" : id}
                    onChange={() => toggle(id)}
                  />
                  <strong>{id}</strong>
                </label>
                <span className="row-meta">
                  {model?.contextWindow ? `${formatWindow(model.contextWindow)} context` : "window unpublished"}
                  {priceLabel(model) ? ` · ${priceLabel(model)}` : ""}
                  {isPrimary ? " · default" : ""}
                </span>
                <div className="actions">
                  <span className="row-meta">
                    intelligence {effective.intelligence} of 10 · speed {effective.speed} · cost {effective.cost}
                  </span>
                  <select
                    value={storedRole(bot.routingProfiles?.[id])}
                    aria-label={`Routing role for ${id}`}
                    disabled={!live}
                    onChange={(event) => setRole(id, event.target.value)}
                  >
                    <option value="family">Family default</option>
                    <option value="quick">Quick</option>
                    <option value="balanced">Balanced</option>
                    <option value="deep">Deep</option>
                  </select>
                  {live ? (
                    <button
                      className="tiny"
                      type="button"
                      disabled={result === "busy"}
                      onClick={() => runTest(id)}
                    >
                      {result === "busy" ? "Testing…" : "Test"}
                    </button>
                  ) : null}
                </div>
                {result && result !== "busy" ? (
                  <p className={result.ok ? "row-meta bot-offered-ok" : "row-meta bot-offered-failed"}>
                    {testLabel(result)}
                  </p>
                ) : null}
              </div>
            );
          })
        : null}
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
        identityOnly={isGrokBotUrl(bot.baseUrl)}
        onChange={(patch) => {
          setProbeNote("");
          store.updateCustomBot(bot.id, patch);
        }}
      />

      {isGrokBotUrl(bot.baseUrl) ? <GrokBotWakeSetup /> : <OfferedModels bot={bot} />}

      <BotRoutingFields bot={bot} />

      <div className="bot-context-row">
        <ContextMeter referenceOnly fallbackWindow={bot.contextWindow} />
        <p className="row-meta">
          {probing
            ? "Testing API…"
            : probeNote ||
              (isGrokBotUrl(bot.baseUrl)
                ? "Private local connection"
                : !bot.apiKey?.trim()
                ? "This key isn't stored. Paste it again to track leftover and send on this bot."
                : `${bot.api === "openai-completions" ? "OpenAI" : "Anthropic"} HTTP · ${formatWindow(bot.contextWindow)} context`)}
        </p>
      </div>
      <div className="actions add-bot-actions">
        {!isGrokBotUrl(bot.baseUrl) ? <button
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
        </button> : null}
      </div>
      <MassSend vendor="custom" customBotId={bot.id} botName={bot.name} />
    </div>
  );
}

type RuntimeFlag = { on: boolean; yes: string; no: string };

/**
 * The four flags stay four. Binary, config, sign-in and reachability fail
 * for different reasons and are fixed in different places, so one
 * "connected" light would hide which one to go and fix.
 */
function runtimeFlags(runtime: AgentRuntimeStatus): RuntimeFlag[] {
  return [
    { on: runtime.binaryPresent, yes: "Binary", no: "No binary" },
    { on: runtime.configPresent, yes: "Config", no: "No config" },
    { on: runtime.authenticated, yes: "Signed in", no: "Not signed in" },
    { on: runtime.reachable, yes: "Reachable", no: "Not reachable" },
  ];
}

const RUNTIME_LABEL: Record<AgentRuntimeId, { name: string; mark: string }> = {
  openclaw: { name: "OpenClaw", mark: "OC" },
  hermes: { name: "Hermes", mark: "H" },
};

const EMPTY_RUNTIMES: AgentRuntimeStatus[] = (["openclaw", "hermes"] as const).map((runtimeId) => ({
  runtimeId,
  binaryPresent: false,
  configPresent: false,
  authenticated: false,
  reachable: false,
}));

const DESK_PERMISSIONS: { id: PermissionMode; label: string }[] = [
  { id: "ask", label: "Ask each time" },
  { id: "accept-edits", label: "Accept edits" },
  { id: "always-approve", label: "Always allow" },
  { id: "plan", label: "Plan mode" },
];

const DESK_SANDBOXES: { id: SandboxProfile; label: string }[] = [
  { id: "off", label: "Full access" },
  { id: "workspace", label: "Workspace only" },
  { id: "read-only", label: "Read-only" },
  { id: "strict", label: "Strict" },
];

/** The desk's standing answer for work that arrives with no chat of its own. */
function DeskAccessBlock() {
  const store = useStore();
  const access = store.settings.access;
  return (
    <div className="settings-group">
      <div className="settings-row settings-group-head">
        <div className="settings-row-copy">
          <strong>Desk access</strong>
          <span>
            What a CLI, MCP or tool call runs under when it names no chat. Always allow so inbound work does not stop
            on a prompt. Narrow it here when you want inbound work held back.
          </span>
          <span>
            A chat that names itself as the parent lends its own setting instead, and a vendor app set narrower than
            this keeps its own limit. Nothing else writes this — connecting or dropping a vendor leaves it alone.
          </span>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-copy">
          <strong>Permission</strong>
        </div>
        <div className="settings-control">
          <div className="actions" role="radiogroup" aria-label="Desk permission">
            {DESK_PERMISSIONS.map((item) => (
              <button
                key={item.id}
                className={access.mode === item.id ? "tiny active-kind" : "tiny"}
                type="button"
                role="radio"
                aria-checked={access.mode === item.id}
                onClick={() => store.setDeskAccess({ mode: item.id })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-copy">
          <strong>Sandbox</strong>
        </div>
        <div className="settings-control">
          <div className="actions" role="radiogroup" aria-label="Desk sandbox">
            {DESK_SANDBOXES.map((item) => (
              <button
                key={item.id}
                className={access.sandbox === item.id ? "tiny active-kind" : "tiny"}
                type="button"
                role="radio"
                aria-checked={access.sandbox === item.id}
                onClick={() => store.setDeskAccess({ sandbox: item.id })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentSystemsBlock() {
  const store = useStore();
  const [note, setNote] = useState("");
  useEffect(() => {
    void store.refreshAgentRuntimes();
  }, []);
  const runtimes = store.agentRuntimes.length ? store.agentRuntimes : EMPTY_RUNTIMES;
  const allowed = new Set(store.settings.agentSystems?.allowedAgents ?? []);
  const toggleAgent = (runtimeId: AgentRuntimeId, agentId: string) => {
    const key = formatExternalAgentRef({ runtimeId, agentId });
    const next = new Set(allowed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    store.updateAgentSystems({ allowedAgents: [...next] });
  };
  const chats = store.sessions.filter((session) => !session.hidden && !session.archivedAt);
  // The picker groups chats by project, the way the sidebar does, so a chat
  // called "Full repo review" can be told apart from another with that name.
  const groups = store.projects
    .map((project) => ({ project, chats: chats.filter((session) => session.projectId === project.id) }))
    .filter((group) => group.chats.length > 0);
  const loose = chats.filter((session) => !session.projectId);
  return (
    <div className="settings-group">
      <div className="settings-row settings-group-head">
        <div className="settings-row-copy">
          <strong>Harnesses</strong>
          <span>Installed runtimes the desk can grant work to.</span>
          <span>
            Workhorse Link lets an outside app call this desk: list, read and ask chats, read leftover, and delegate a
            task. The installed MCP can read leftover and availability. That check does not share keys or chats.
            Connecting creates no vendor, login or Usage ring.
          </span>
          {note ? <span className="settings-row-note">{note}</span> : null}
        </div>
        <div className="settings-control">
          <button className="tiny" type="button" onClick={() => void store.refreshAgentRuntimes()}>
            Recheck
          </button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-copy">
          <strong>Workhorse Link</strong>
          <span>Each button writes the same launch into that app’s own MCP config, through its own tool.</span>
        </div>
        <div className="settings-control link-connect">
          {LINK_HOSTS.map((host) => (
            <button
              className="tiny"
              type="button"
              key={host}
              onClick={() => {
                if (linkHostConnectsByOneshot(host)) {
                  void store.linkGrokBotOneshot().then(async (text) => {
                    if (!text) {
                      setNote("Workhorse desktop only.");
                      return;
                    }
                    try {
                      await navigator.clipboard.writeText(text);
                      setNote("Copied. Paste into Grok Bot once and tell it to save in permanent memory.");
                    } catch {
                      setNote(text);
                    }
                  });
                  return;
                }
                void store.installExternalMcp([host]).then((result) => setNote(result.message || (result.ok ? `Connected ${LINK_HOST_LABEL[host]}.` : `Could not connect ${LINK_HOST_LABEL[host]}.`)));
              }}
            >
              Connect {LINK_HOST_LABEL[host]}
            </button>
          ))}
          <button
            className="tiny"
            type="button"
            onClick={() => {
              void store.linkConfig().then(async (text) => {
                if (!text) {
                  setNote("Workhorse desktop only.");
                  return;
                }
                try {
                  await navigator.clipboard.writeText(text);
                  setNote("Copied the generic MCP configuration. Paste it into any MCP client’s servers list.");
                } catch {
                  setNote(text);
                }
              });
            }}
          >
            Copy generic MCP configuration
          </button>
          <button
            className="tiny"
            type="button"
            onClick={() => {
              void store.installLinkCommand().then((result) => setNote(result.message || (result.ok ? "Installed the workhorse command." : "Could not install the command.")));
            }}
          >
            Install workhorse command
          </button>
        </div>
      </div>
      {runtimes.map((runtime) => {
        const label = RUNTIME_LABEL[runtime.runtimeId];
        const agents = store.agentCatalog.filter((agent) => agent.runtimeId === runtime.runtimeId);
        const live = runtime.reachable && runtime.authenticated;
        return (
          <div className="settings-row runtime-row" key={runtime.runtimeId}>
            <span className={`runtime-tile${live ? " on" : ""}`} aria-hidden="true">
              {label.mark}
            </span>
            <div className="settings-row-copy">
              <strong>
                {label.name}
                {runtime.version ? <small>{runtime.version}</small> : null}
              </strong>
              {agents.length > 0 ? (
                <span className="agent-chips" role="group" aria-label={`${label.name} agents`}>
                  {agents.map((agent) => (
                    <button
                      className={`agent-chip${allowed.has(formatExternalAgentRef(agent)) ? " on" : ""}`}
                      key={agent.agentId}
                      type="button"
                      aria-pressed={allowed.has(formatExternalAgentRef(agent))}
                      title={agent.workspace ?? agent.name}
                      onClick={() => toggleAgent(agent.runtimeId, agent.agentId)}
                    >
                      {agent.name}
                    </button>
                  ))}
                </span>
              ) : (
                <span>No agents found.</span>
              )}
            </div>
            <div className="settings-control status-chips" role="list" aria-label={`${label.name} status`}>
              {runtimeFlags(runtime).map((flag) => (
                <span className={`status-chip${flag.on ? " on" : ""}`} role="listitem" key={flag.yes}>
                  {flag.on ? flag.yes : flag.no}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      <label className="settings-row">
        <div className="settings-row-copy">
          <strong>Inbound parent</strong>
          <span>
            When OpenClaw or Hermes spawns a worker here without naming a chat, a new chat is created there. Chats is
            the default. Pick a project to land it in that project, or a thread to nest under that chat.
          </span>
        </div>
        <div className="settings-control">
          <select
            value={inboundParentSelectValue(store.settings.agentSystems)}
            onChange={(event) => store.updateAgentSystems(agentSystemsFromInboundSelect(event.target.value))}
            aria-label="Inbound parent"
          >
            <option value="">Chats</option>
            {store.projects.length > 0 ? (
              <optgroup label="Projects">
                {store.projects.map((project) => (
                  <option key={project.id} value={`project:${project.id}`}>
                    {project.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {groups.map((group) => (
              <optgroup key={group.project.id} label={group.project.name}>
                {group.chats.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title || session.id}
                  </option>
                ))}
              </optgroup>
            ))}
            {loose.length > 0 ? (
              <optgroup label="Chats">
                {loose.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title || session.id}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>
      </label>
    </div>
  );
}

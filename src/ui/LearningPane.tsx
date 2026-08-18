import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import {
  BACKFILL_COMPILE_RUN_CAP,
  backfillHumanPromptEvents,
  compileBatchSettled,
  describeBackfillResult,
  describeCompileResult,
} from "../lib/learning-backfill";
import { eligibleLearningCompilers, isEligibleLearningCompiler } from "../lib/learning-policy";
import type { CompileResult, LearningIndexStats, LearningMode, MemoryItem } from "../lib/learning-types";
import { attachedCustomBots } from "../lib/settings";

const MODES: { id: LearningMode; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Learning is off. Nothing is recorded." },
  { id: "capture", label: "Capture", hint: "Record redacted events. Do not compile." },
  { id: "review", label: "Review", hint: "Propose memories. Approve before they become active." },
  { id: "automatic", label: "Automatic", hint: "Promote statements that pass evidence gates." },
];

const ACP_COMPILER_HINT = "The compiler must be a custom bot. ACP cannot do a title-less call.";

export function LearningPane() {
  const store = useStore();
  const learning = store.settings.learning;
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [indexStats, setIndexStats] = useState<LearningIndexStats | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [note, setNote] = useState("");
  const [forgetOpen, setForgetOpen] = useState(false);

  const refreshMemories = () => {
    void window.workhorse?.learningMemories?.().then((rows) => setMemories(rows ?? [])).catch(() => undefined);
  };

  const refreshIndexStats = async () => {
    try {
      const stats = (await window.workhorse?.learningStats?.()) ?? null;
      setIndexStats(stats);
      return stats;
    } catch {
      setIndexStats(null);
      return null;
    }
  };

  const refresh = () => {
    refreshMemories();
    void refreshIndexStats();
  };

  useEffect(() => {
    refresh();
  }, [learning.mode]);

  const bots = attachedCustomBots(store.settings);
  const compilerOptions = eligibleLearningCompilers(bots);
  const acpAssigned = Boolean(learning.compilerProvider && !isEligibleLearningCompiler(learning.compilerProvider));
  const compilerValue = isEligibleLearningCompiler(learning.compilerProvider)
    ? (learning.compilerCustomBotId ?? "")
    : "";
  const assignedBot = compilerOptions.find((item) => item.customBotId === compilerValue);
  const compilerHint = !bots.length || acpAssigned ? ACP_COMPILER_HINT : "Turns captured events into memories.";

  const botNameFor = (result?: CompileResult) => {
    const id = result?.customBotId ?? assignedBot?.customBotId;
    return (
      compilerOptions.find((item) => item.customBotId === id)?.label ??
      assignedBot?.label ??
      (result?.provider === "custom" ? result.model : undefined)
    );
  };

  const runCompile = async (): Promise<CompileResult | undefined> => {
    const result = await window.workhorse?.learningCompile?.();
    return result;
  };

  const compileUntilSettled = async (): Promise<CompileResult> => {
    let last: CompileResult = { ran: false, skipped: "empty" };
    let memoriesWritten = 0;
    let ran = false;
    for (let i = 0; i < BACKFILL_COMPILE_RUN_CAP; i += 1) {
      const result = await runCompile();
      if (!result) break;
      last = result;
      if (result.ran) {
        ran = true;
        memoriesWritten += result.memories ?? 0;
      }
      if (compileBatchSettled(result)) break;
    }
    return { ...last, ran, memories: ran ? memoriesWritten : last.memories };
  };

  const exportLearning = async () => {
    // pickExportFolder returns a PickedFolder now, not a bare path: macOS needs
    // the security bookmark alongside it.
    const dest = await window.workhorse?.pickExportFolder?.();
    if (!dest?.path) return;
    const result = await window.workhorse?.learningExport?.(dest.path);
    setNote(result?.ok ? "Exported." : result?.message || "Export failed.");
  };

  const forget = async (permanent: boolean) => {
    const result = permanent
      ? await window.workhorse?.learningPurge?.({ all: true })
      : await window.workhorse?.learningForget?.({ all: true });
    setForgetOpen(false);
    setNote(permanent ? (result && "verifiedAbsent" in result && result.verifiedAbsent ? "Purged." : "Purge failed.") : "Forgotten.");
    refresh();
  };

  const compileBrief = async () => {
    const result = await runCompile();
    if (result) setNote(describeCompileResult(result, botNameFor(result)));
    refresh();
  };

  const showCapturedSources = async () => {
    setShowSources(true);
    const stats = await refreshIndexStats();
    refreshMemories();
    setNote(stats?.indexedEvents ? `${stats.indexedEvents} private source events indexed.` : "No captured events.");
  };

  const backfillLastDay = async () => {
    const drafts = backfillHumanPromptEvents({ sessions: store.sessions, now: Date.now() });
    let recorded = 0;
    for (const draft of drafts) {
      const result = await window.workhorse?.learningRecord?.(draft);
      if (result?.inserted) recorded += 1;
    }
    const compiled = await compileUntilSettled();
    setShowSources(true);
    setNote(describeBackfillResult({ recorded, compile: compiled, botName: botNameFor(compiled) }));
    refresh();
  };

  return (
    <>
      <div className="settings-group">
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>Learning</strong>
            <span>{MODES.find((mode) => mode.id === learning.mode)?.hint} Private memory, on this disk only.</span>
          </div>
          <div className="settings-control">
            <div className="actions" role="radiogroup" aria-label="Learning">
              {MODES.map((mode) => (
                <button
                  key={mode.id}
                  className={learning.mode === mode.id ? "tiny active-kind" : "tiny"}
                  type="button"
                  role="radio"
                  aria-checked={learning.mode === mode.id}
                  onClick={() => store.updateLearning({ mode: mode.id })}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label className="settings-row">
          <div className="settings-row-copy">
            <strong>Compiler model</strong>
            <span>{compilerHint}</span>
          </div>
          <div className="settings-control">
            <select
              value={compilerValue}
              onChange={(event) => {
                const option = compilerOptions.find((item) => item.customBotId === event.target.value);
                store.updateLearning({
                  compilerProvider: option?.provider,
                  compilerModel: option?.model,
                  compilerCustomBotId: option?.customBotId,
                });
              }}
            >
              <option value="">Policy selects an eligible custom bot</option>
              {compilerOptions.map((item) => (
                <option key={item.customBotId} value={item.customBotId}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </label>
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>Store</strong>
            <span>Read the intelligence brief, check the private index, take a copy, or forget it.</span>
          </div>
          <div className="settings-control">
            <div className="actions">
              <button className="tiny" type="button" onClick={() => void compileBrief()}>
                Learning brief
              </button>
              <button className="tiny" type="button" onClick={() => void showCapturedSources()}>
                Index
              </button>
              <button className="tiny" type="button" onClick={() => void backfillLastDay()}>
                Backfill last day
              </button>
              <button className="tiny" type="button" onClick={() => void exportLearning()}>
                Export
              </button>
              <button className="tiny" type="button" onClick={() => setForgetOpen(true)}>
                Forget
              </button>
            </div>
          </div>
        </div>
      </div>
      {forgetOpen ? (
        <div className="link-block" role="alertdialog" aria-label="Forget learning">
          <p className="row-meta">Forget tombstones sources. Purge permanently rebuilds the store.</p>
          <div className="actions">
            <button className="tiny" type="button" onClick={() => void forget(false)}>
              Forget
            </button>
            <button className="tiny" type="button" onClick={() => void forget(true)}>
              Purge
            </button>
            <button className="tiny" type="button" onClick={() => setForgetOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {note ? <p className="row-meta">{note}</p> : null}
      <div className="usage-brains">
        {memories.map((memory) => (
          <div className="usage-brain" key={memory.id}>
            <span className="llm-mark on">{memory.memoryClass === "intent" ? "I" : "O"}</span>
            <span>{memory.statement}</span>
            <em>
              {memory.scope} · {memory.sourceEventIds.length} · {memory.status}
              {memory.lastConfirmedAt ? ` · ${new Date(memory.lastConfirmedAt).toISOString().slice(0, 10)}` : ""}
            </em>
            {memory.status === "proposed" ? (
              <button className="tiny" type="button" onClick={() => void window.workhorse?.learningApprove?.(memory.id).then(refresh)}>
                Approve
              </button>
            ) : null}
            <details>
              <summary>Provenance</summary>
              <p className="row-meta">{memory.sourceEventIds.join(", ") || "none"}</p>
            </details>
          </div>
        ))}
      </div>
      {showSources && indexStats ? (
        <div className="link-block" aria-label="Private learning index">
          <strong>Private source index</strong>
          <p className="row-meta">
            {indexStats.indexedEvents} events on disk · {indexStats.indexedHumanEvents} human · {indexStats.compiledEvents} analyzed
          </p>
          <p className="row-meta">
            {indexStats.memories} intelligence records · {indexStats.completedRuns} completed compiler runs
          </p>
          <p className="row-meta">Prompt text stays in SQLite and is not shown here.</p>
        </div>
      ) : null}
    </>
  );
}

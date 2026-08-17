import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import type { LearningMode, MemoryItem } from "../lib/learning-types";
import { modelsFor } from "../lib/models";
import { attachedCustomBots, attachedStockVendors } from "../lib/settings";

const MODES: { id: LearningMode; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Learning is off. Nothing is recorded." },
  { id: "capture", label: "Capture", hint: "Record redacted events. Do not compile." },
  { id: "review", label: "Review", hint: "Propose memories. Approve before they become active." },
  { id: "automatic", label: "Automatic", hint: "Promote statements that pass evidence gates." },
];

export function LearningPane() {
  const store = useStore();
  const learning = store.settings.learning;
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [note, setNote] = useState("");
  const [forgetOpen, setForgetOpen] = useState(false);

  const refresh = () => {
    void window.workhorse?.learningMemories?.().then((rows) => setMemories(rows ?? [])).catch(() => undefined);
  };

  useEffect(() => {
    refresh();
  }, [learning.mode]);

  const stock = attachedStockVendors(store.settings);
  const bots = attachedCustomBots(store.settings);
  const compilerOptions: Array<{ provider: typeof stock[number] | "custom"; model: string; label: string; customBotId?: string }> = [
    ...stock.flatMap((provider) => modelsFor(provider).map((model) => ({ provider, model: model.id, label: `${provider} · ${model.name}` }))),
    ...bots.map((bot) => ({ provider: "custom" as const, model: bot.model, customBotId: bot.id, label: bot.name })),
  ];

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
            <span>Turns captured events into memories.</span>
          </div>
          <div className="settings-control">
            <select
              value={learning.compilerCustomBotId ?? `${learning.compilerProvider ?? ""}:${learning.compilerModel ?? ""}`}
              onChange={(event) => {
                const option = compilerOptions.find((item) => (item.customBotId ?? `${item.provider}:${item.model}`) === event.target.value);
                store.updateLearning({
                  compilerProvider: option?.provider,
                  compilerModel: option?.model,
                  compilerCustomBotId: option?.customBotId,
                });
              }}
            >
              <option value="">Policy selects an eligible model</option>
              {compilerOptions.map((item) => (
                <option key={item.customBotId ?? `${item.provider}:${item.model}`} value={item.customBotId ?? `${item.provider}:${item.model}`}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </label>
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>Store</strong>
            <span>Read the brief and its sources, take a copy, or forget it.</span>
          </div>
          <div className="settings-control">
            <div className="actions">
              <button className="tiny" type="button" onClick={() => void window.workhorse?.learningCompile?.().then(refresh)}>
                Learning brief
              </button>
              <button className="tiny" type="button" onClick={refresh}>
                Sources
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
    </>
  );
}

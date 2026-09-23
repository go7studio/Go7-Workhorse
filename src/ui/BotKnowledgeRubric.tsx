import { useEffect, useMemo, useState } from "react";
import { ORCHESTRATION_TASK_DOMAINS } from "../lib/domain-benchmark";
import {
  botKnowledgeModelKey,
  botKnowledgeRubricForModel,
  catalogDomainBenchmarkScore,
  type BotKnowledgeRubricOverride,
} from "../lib/bot-knowledge-rubric";
import { customModelRoutingOverride } from "../lib/custom-bots";
import type { ProviderId, Settings, TaskDomain } from "../lib/types";

const DOMAIN_LABEL: Record<TaskDomain, string> = {
  coding: "Coding",
  "image-generation": "Image generation",
  writing: "Writing",
  visual: "Visual",
  data: "Data",
  general: "General",
};

export type RubricTarget = {
  provider: ProviderId;
  model: string;
  customBotId?: string;
  label: string;
};

function RubricGearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.4 1.6h3.2l.4 1.7a4.8 4.8 0 0 1 1.3.8l1.7-.5 1.6 2.8-1.3 1.2c.1.5.1.9 0 1.4l1.3 1.2-1.6 2.8-1.7-.5a4.8 4.8 0 0 1-1.3.8l-.4 1.7H6.4l-.4-1.7a4.8 4.8 0 0 1-1.3-.8l-1.7.5L1.4 9.9l1.3-1.2a4.8 4.8 0 0 1 0-1.4L1.4 6.1l1.6-2.8 1.7.5a4.8 4.8 0 0 1 1.3-.8l.4-1.4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function BotKnowledgeRubricButton({
  label,
  onOpen,
}: {
  label: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="bk-rubric-cog" aria-label={`Rubric for ${label}`} title="Edit rubric" onClick={onOpen}>
      <RubricGearIcon />
    </button>
  );
}

export function BotKnowledgeRubricSheet({
  target,
  settings,
  onClose,
  onSave,
  onReset,
}: {
  target: RubricTarget;
  settings: Settings;
  onClose: () => void;
  onSave: (key: string, rubric: BotKnowledgeRubricOverride) => void;
  onReset: (key: string) => void;
}) {
  const key = botKnowledgeModelKey(target.provider, target.model, target.customBotId);
  const bot = settings.customBots.find((item) => item.id === target.customBotId);
  const routingOverride = bot ? customModelRoutingOverride(bot, target.model) : undefined;
  const saved = botKnowledgeRubricForModel(settings.botKnowledge, target.provider, target.model, target.customBotId);

  const catalog = useMemo(
    () =>
      Object.fromEntries(
        ORCHESTRATION_TASK_DOMAINS.map((domain) => {
          const { score, source } = catalogDomainBenchmarkScore(target.provider, target.model, domain, routingOverride);
          return [domain, { score, source }] as const;
        }),
      ) as Record<TaskDomain, { score: number; source: string }>,
    [target.provider, target.model, routingOverride],
  );

  const [domainScores, setDomainScores] = useState<Partial<Record<TaskDomain, number>>>(() => ({
    ...(saved?.domainScores ?? {}),
  }));
  const [sortWeight, setSortWeight] = useState(() => saved?.sortWeight ?? 0);

  useEffect(() => {
    setDomainScores({ ...(saved?.domainScores ?? {}) });
    setSortWeight(saved?.sortWeight ?? 0);
  }, [key, saved?.domainScores, saved?.sortWeight]);

  useEffect(() => {
    const scroller = document.querySelector(".settings.settings-full");
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const displayScore = (domain: TaskDomain) =>
    domainScores[domain] !== undefined ? domainScores[domain]! : catalog[domain].score;

  const save = () => {
    const patch: BotKnowledgeRubricOverride = { sortWeight };
    const scores: Partial<Record<TaskDomain, number>> = {};
    for (const domain of ORCHESTRATION_TASK_DOMAINS) {
      const value = domainScores[domain];
      if (value !== undefined && value !== catalog[domain].score) scores[domain] = value;
    }
    if (Object.keys(scores).length > 0) patch.domainScores = scores;
    onSave(key, patch);
    onClose();
  };

  const reset = () => {
    onReset(key);
    onClose();
  };

  return (
    <div className="bk-rubric-backdrop" role="presentation" onClick={onClose}>
      <div
        className="bk-rubric-sheet"
        role="dialog"
        aria-labelledby="bk-rubric-title"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="bk-rubric-head">
          <div>
            <h3 id="bk-rubric-title">{target.label}</h3>
            <p className="bk-rubric-lead">Your scores for this model only. Orchestration and this list read them.</p>
          </div>
          <button type="button" className="bk-rubric-close" aria-label="Close rubric" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="bk-rubric-body">
          <div className="bk-rubric-weight">
            <label htmlFor="bk-rubric-sort-weight">
              <strong>Sort weight</strong>
              <span>Higher lifts this bot within the same score after callable.</span>
            </label>
            <input
              id="bk-rubric-sort-weight"
              type="number"
              min={0}
              max={10}
              step={1}
              value={sortWeight}
              aria-label="Sort weight"
              title="Higher lifts this bot within the same score after callable"
              onChange={(event) => setSortWeight(Number(event.target.value))}
            />
          </div>
          <ul className="bk-rubric-domains">
            {ORCHESTRATION_TASK_DOMAINS.map((domain) => {
              const base = catalog[domain];
              const edited = domainScores[domain];
              const shown = displayScore(domain);
              const catalogLine = `Without yours: ${base.score}/100 · ${base.source}`;
              return (
                <li key={domain}>
                  <div className="bk-rubric-domain-head">
                    <strong>{DOMAIN_LABEL[domain]}</strong>
                    <span className="bk-rubric-domain-meta">
                      {edited !== undefined && edited !== base.score ? (
                        <span className="bk-rubric-edited">Manual</span>
                      ) : null}
                      <output>{shown}/100</output>
                    </span>
                  </div>
                  <p className="bk-rubric-catalog" title={catalogLine}>
                    {catalogLine}
                  </p>
                  <div className="bk-rubric-domain-control">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={shown}
                      aria-label={`${DOMAIN_LABEL[domain]} score`}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setDomainScores((current) => {
                          if (next === base.score) {
                            const { [domain]: _, ...rest } = current;
                            return rest;
                          }
                          return { ...current, [domain]: next };
                        });
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <footer className="bk-rubric-foot">
          <button type="button" className="ghost" onClick={reset}>
            Reset to the boards
          </button>
          <div className="bk-rubric-foot-actions">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={save}>
              Save
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

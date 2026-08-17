import { useState } from "react";
import { BOT_COLORS } from "../lib/custom-bots";
import {
  PROVIDER_PRESETS,
  detectProviderFromKey,
  detectProviderFromUrl,
  draftFromProvider,
  fillEmptyFromProvider,
  findProvider,
} from "../lib/provider-catalog";
import { groupModelIds, modelChipLabel, parseModelId } from "../lib/model-groups";
import { ColorWheel } from "./ColorWheel";

const BASE_COLORS = new Set(BOT_COLORS.map((swatch) => swatch.value.toLowerCase()));

export type BotFormValue = {
  name: string;
  color: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: "openai-completions" | "anthropic-messages";
  contextWindow?: number;
  /** Models approved for this bot. The default model is always among them. */
  models?: string[];
  /** What the provider's own /models offered. The offer, not the choice. */
  discovered?: string[];
};

/**
 * The models this key may be used for. Testing the connection asks the
 * provider what it serves — Synthetic answers with dozens — and the owner
 * ticks the ones they want. A chat can only ever reach an approved model.
 * The default model is always approved and cannot be unticked.
 */
function ApprovedModels({
  value,
  onChange,
}: {
  value: BotFormValue;
  onChange: (patch: Partial<BotFormValue>) => void;
}) {
  const primary = (value.model ?? "").trim();
  const offered = (value.discovered ?? []).filter((id) => id !== primary);
  if (offered.length === 0) return null;
  const approved = new Set(value.models ?? []);
  const groups = groupModelIds(offered);
  const toggle = (id: string) => {
    const next = new Set(approved);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ models: [...next].filter((item) => item !== primary) });
  };
  const setGroup = (ids: string[], on: boolean) => {
    const next = new Set(approved);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange({ models: [...next].filter((item) => item !== primary) });
  };
  return (
    <div className="field wide bot-models">
      <span>Models on this key</span>
      <p className="row-meta">
        {`${offered.length} more offered, newest first. Tick what a chat may use — one key, one bill, one leftover ring.`}
      </p>
      <div className="bot-model-group">
        <div className="section-label">Default</div>
        <div className="setup-effort setup-models">
          <button type="button" className="on" aria-pressed disabled title="The default model is always approved">
            <strong>{modelChipLabel(parseModelId(primary))}</strong>
            <span>always on</span>
          </button>
        </div>
      </div>
      {groups.map((group) => {
        const ids = group.models.map((model) => model.id);
        const all = ids.every((id) => approved.has(id));
        // One group is not a grouping. A provider whose ids carry no maker —
        // MiniMax answers M3, M2.7, M2.5 — would otherwise sit under a header
        // reading "Other", which says nothing and costs a line.
        const label = groups.length > 1 ? group.label : "";
        return (
          <div className="bot-model-group" key={group.key}>
            <div className="section-label">
              {label}
              <button type="button" className="tiny" onClick={() => setGroup(ids, !all)}>
                {all ? "None" : "All"}
              </button>
            </div>
            <div className="setup-effort setup-models" role="group" aria-label={`${group.label} models`}>
              {group.models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className={approved.has(model.id) ? "on" : undefined}
                  aria-pressed={approved.has(model.id)}
                  title={model.id}
                  onClick={() => toggle(model.id)}
                >
                  <strong>{modelChipLabel(model)}</strong>
                  <span>{model.params ? `${model.params}B` : model.alias ? "routes to best" : " "}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function BotForm({
  value,
  onChange,
  identityOnly = false,
  defaultColor,
  namePlaceholder = "Bot name",
}: {
  value: BotFormValue;
  onChange: (patch: Partial<BotFormValue>) => void;
  identityOnly?: boolean;
  defaultColor?: string;
  namePlaceholder?: string;
}) {
  const [wheelOpen, setWheelOpen] = useState(false);
  const customColor = Boolean(value.color) && !BASE_COLORS.has(value.color.toLowerCase());
  const matched = detectProviderFromUrl(value.baseUrl ?? "") ?? detectProviderFromKey(value.apiKey ?? "");
  const providerId = matched?.id ?? "";
  const applyProvider = (id: string) => {
    if (!id) return;
    const preset = findProvider(id);
    if (!preset) return;
    onChange(fillEmptyFromProvider({ ...value, baseUrl: "", model: "", contextWindow: 128_000 }, preset));
  };
  return (
    <div className="add-bot-form">
      {identityOnly ? null : (
        <label className="field wide">
          <span>Provider</span>
          <select
            value={providerId}
            onChange={(event) => applyProvider(event.target.value)}
          >
            <option value="">Custom URL</option>
            {PROVIDER_PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Bot name</span>
        <input
          value={value.name}
          placeholder={namePlaceholder}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <div className="field">
        <span>Color</span>
        <div className="bot-swatches">
          {identityOnly && (
            <button
              key="default"
              className={`bot-swatch${value.color ? "" : " on"}`}
              type="button"
              style={{ background: defaultColor || "var(--text-tertiary)" }}
              aria-label="Default color"
              title="Default"
              onClick={() => onChange({ color: "" })}
            />
          )}
          {BOT_COLORS.map((swatch) => (
            <button
              key={swatch.id}
              className={`bot-swatch${value.color === swatch.value ? " on" : ""}`}
              type="button"
              style={{ background: swatch.value }}
              aria-label={swatch.label}
              title={swatch.label}
              onClick={() => onChange({ color: swatch.value })}
            />
          ))}
          <button
            className={`bot-swatch wheel-toggle${customColor || wheelOpen ? " on" : ""}`}
            type="button"
            aria-expanded={wheelOpen}
            aria-label="More colors"
            title="More colors"
            onClick={() => setWheelOpen((open) => !open)}
          >
            <i style={customColor ? { background: value.color } : undefined} />
          </button>
        </div>
      </div>
      {wheelOpen && (
        <div className="field bot-wheel-field">
          <ColorWheel color={value.color || "#0071e3"} onChange={(color) => onChange({ color })} />
        </div>
      )}
      {identityOnly ? null : (
        <>
          <label className="field">
            <span>Model</span>
            {matched ? (
              <select
                value={value.model}
                onChange={(event) => onChange(draftFromProvider(matched, event.target.value))}
              >
                {matched.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={value.model}
                placeholder="model-id"
                onChange={(event) => onChange({ model: event.target.value })}
              />
            )}
          </label>
          <label className="field">
            <span>Base URL</span>
            <input
              value={value.baseUrl}
              placeholder="https://api.example.com"
              onChange={(event) => onChange({ baseUrl: event.target.value })}
            />
          </label>
          <label className="field">
            <span>API key</span>
            <input
              type="password"
              value={value.apiKey}
              placeholder="Stored only on this computer"
              autoComplete="off"
              onChange={(event) => {
                const apiKey = event.target.value;
                const preset = detectProviderFromKey(apiKey);
                if (preset && !(value.baseUrl ?? "").trim()) {
                  onChange(fillEmptyFromProvider({ ...value, apiKey }, preset));
                  return;
                }
                onChange({ apiKey });
              }}
            />
          </label>
          <label className="field">
            <span>Context window</span>
            <input
              type="number"
              min={1024}
              step={1024}
              value={value.contextWindow}
              onChange={(event) => onChange({ contextWindow: Number(event.target.value) || 128000 })}
            />
          </label>
          <ApprovedModels value={value} onChange={onChange} />
        </>
      )}
    </div>
  );
}

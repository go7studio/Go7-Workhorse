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
};

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
        </>
      )}
    </div>
  );
}

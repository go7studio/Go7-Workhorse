import { useState } from "react";
import { BOT_COLORS } from "../lib/custom-bots";
import { ColorWheel } from "./ColorWheel";

const BASE_COLORS = new Set(BOT_COLORS.map((swatch) => swatch.value.toLowerCase()));

export type BotFormValue = {
  name: string;
  color: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
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
  return (
    <div className="add-bot-form">
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
            <input
              value={value.model}
              placeholder="model-id"
              onChange={(event) => onChange({ model: event.target.value })}
            />
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
              onChange={(event) => onChange({ apiKey: event.target.value })}
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

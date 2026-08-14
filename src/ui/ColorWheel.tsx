import { useEffect, useRef, useState } from "react";
import { colorFromWheel, hexToHsv, hsvToHex, parseHex, rgbToHex } from "../lib/color";

export function ColorWheel({
  color,
  onChange,
}: {
  color: string;
  onChange: (hex: string) => void;
}) {
  const disk = useRef<HTMLDivElement>(null);
  const hsv = hexToHsv(color) ?? { h: 211, s: 1, v: 0.89 };
  const [hexDraft, setHexDraft] = useState(color || hsvToHex(hsv.h, hsv.s, hsv.v));

  useEffect(() => {
    setHexDraft(color || hsvToHex(hsv.h, hsv.s, hsv.v));
  }, [color, hsv.h, hsv.s, hsv.v]);

  const pick = (clientX: number, clientY: number) => {
    const box = disk.current?.getBoundingClientRect();
    if (!box) return;
    const x = clientX - (box.left + box.width / 2);
    const y = clientY - (box.top + box.height / 2);
    onChange(colorFromWheel(x, y, box.width / 2, hsv.v));
  };

  const commitHex = () => {
    const parsed = parseHex(hexDraft);
    if (!parsed) {
      setHexDraft(color || hsvToHex(hsv.h, hsv.s, hsv.v));
      return;
    }
    onChange(rgbToHex(parsed[0], parsed[1], parsed[2]));
  };

  return (
    <div className="color-wheel">
      <div
        ref={disk}
        className="color-wheel-disk"
        role="slider"
        aria-label="Color wheel"
        aria-valuetext={color || hsvToHex(hsv.h, hsv.s, hsv.v)}
        style={{ ["--wheel-value" as string]: String(hsv.v) }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pick(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 0) return;
          pick(event.clientX, event.clientY);
        }}
      >
        <i
          className="color-wheel-thumb"
          style={{
            left: `${50 + Math.cos((hsv.h * Math.PI) / 180) * hsv.s * 46}%`,
            top: `${50 + Math.sin((hsv.h * Math.PI) / 180) * hsv.s * 46}%`,
            background: hsvToHex(hsv.h, hsv.s, hsv.v),
          }}
        />
      </div>
      <div className="color-wheel-side">
        <label className="field">
          <span>Brightness</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(hsv.v * 100)}
            aria-label="Brightness"
            onChange={(event) => onChange(hsvToHex(hsv.h, hsv.s, Number(event.target.value) / 100))}
          />
        </label>
        <label className="field">
          <span>Hex</span>
          <input
            value={hexDraft}
            spellCheck={false}
            autoComplete="off"
            aria-label="Hex color"
            onChange={(event) => setHexDraft(event.target.value)}
            onBlur={commitHex}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitHex();
              }
            }}
          />
        </label>
      </div>
    </div>
  );
}

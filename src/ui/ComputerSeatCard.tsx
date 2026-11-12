import type { ComputerSeat } from "../lib/computer-seat";

/**
 * The per-chat Computer switch. It sits on the existing access card, beside
 * Permission and Sandbox.
 */
export function ComputerSeatCard({
  computer,
  worker = false,
  onChange,
}: {
  computer: ComputerSeat;
  worker?: boolean;
  onChange: (computer: ComputerSeat) => void;
}) {
  return (
    <div className="setup-block">
      <div className="setup-choice-title">
        <strong>Computer</strong>
      </div>
      <div className="setup-grid" role="radiogroup" aria-label="Computer">
        {(["off", "on"] as const).map((value) => (
          <button
            key={value}
            className={computer === value ? "on" : undefined}
            type="button"
            role="radio"
            aria-checked={computer === value}
            onClick={() => onChange(value)}
          >
            <span className="setup-choice-copy">
              <strong>{value === "on" ? "On" : "Off"}</strong>
            </span>
          </button>
        ))}
      </div>
      <p className="setup-lede">
        {worker
          ? "Spawn leaves Computer off. Turn it on here if this worker should drive the desktop."
          : "Drive Finder, Explorer, and System Settings from this chat. Workers do not inherit it."}
      </p>
    </div>
  );
}

import type { ComputerChoice } from "../lib/computer-seat";

const CHOICES: { id: ComputerChoice; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "on", label: "On" },
  { id: "always", label: "Always" },
];

/**
 * The Computer control beside Permission and Sandbox.
 * Off and On are this chat. Always keeps this model on across chats.
 */
export function ComputerSeatCard({
  choice,
  worker = false,
  onChange,
}: {
  choice: ComputerChoice;
  worker?: boolean;
  onChange: (choice: ComputerChoice) => void;
}) {
  return (
    <div className="setup-block">
      <div className="setup-choice-title">
        <strong>Computer</strong>
      </div>
      <div className="setup-effort setup-segment" role="radiogroup" aria-label="Computer">
        {CHOICES.map((item) => (
          <button
            key={item.id}
            className={choice === item.id ? "on" : undefined}
            type="button"
            role="radio"
            aria-checked={choice === item.id}
            onClick={() => onChange(item.id)}
          >
            <span className="setup-choice-copy">
              <strong>{item.label}</strong>
            </span>
          </button>
        ))}
      </div>
      <p className="setup-lede">
        {worker
          ? "This worker inherited the parent chat. Always keeps this model on. The parent can pass computer false to withhold it."
          : "On drives Finder, Explorer, and System Settings from this chat. Always keeps this model on across chats. A spawn hands this seat down unless that call passes computer false."}
      </p>
    </div>
  );
}

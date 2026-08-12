import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands } from "../lib/commands";
import { useStore } from "../lib/store";
import { ModelMenu } from "./ModelMenu";

export function Composer() {
  const { send } = useStore();
  const [value, setValue] = useState("");
  const [active, setActive] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);

  const open = value.startsWith("/");
  const matches = useMemo(() => (open ? filterCommands(value) : []), [open, value]);
  const query = open ? value.replace(/^\//, "") : "";

  useEffect(() => {
    setActive(0);
  }, [value]);

  const submit = (text = value) => {
    if (!text.trim()) return;
    send(text);
    setValue("");
  };

  return (
    <div className="composer-wrap">
      {open && matches.length > 0 && (
        <div className="palette-overlay" role="presentation">
          <div className="palette" role="listbox">
            <div className="palette-search">
              <span>/</span>
              <em>{query || "commands"}</em>
            </div>
            {matches.map((command, index) => (
              <button
                key={command.id}
                className={index === active ? "active" : undefined}
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => submit(command.name)}
              >
                <code>{command.name}</code>
                <em>{command.hint}</em>
              </button>
            ))}
          </div>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (open && matches[active]) submit(matches[active].name);
          else submit();
        }}
      >
        <ModelMenu />
        <textarea
          ref={field}
          rows={1}
          value={value}
          placeholder="Message, or type /"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => (index + delta + matches.length) % Math.max(matches.length, 1));
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (open && matches[active]) submit(matches[active].name);
              else submit();
            }
            if (event.key === "Escape") setValue("");
          }}
        />
        <button className="send" type="submit">
          Send
        </button>
      </form>
    </div>
  );
}

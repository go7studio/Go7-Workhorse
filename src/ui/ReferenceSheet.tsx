import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import type { ReferenceKind } from "../lib/types";

export function ReferenceSheet() {
  const { sheet, addReference, closeSheet } = useStore();
  const [kind, setKind] = useState<ReferenceKind>("url");
  const [value, setValue] = useState("");
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sheet === "reference") {
      setKind("url");
      setValue("");
      requestAnimationFrame(() => field.current?.focus());
    }
  }, [sheet]);

  if (sheet !== "reference") return null;

  const submit = async (nextKind = kind) => {
    if (nextKind === "file") {
      const picked = window.workhorse ? await window.workhorse.pickFile() : null;
      if (picked) addReference("file", picked);
      closeSheet();
      return;
    }
    addReference(nextKind, value);
    closeSheet();
  };

  return (
    <div className="sheet-backdrop" onClick={closeSheet}>
      <form
        className="sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h3>Add a reference</h3>
        <p>A file, URL, or note this project should remember. Not a folder.</p>
        <div className="actions" style={{ marginBottom: 12 }}>
          {(["url", "note", "file"] as const).map((item) => (
            <button
              key={item}
              className={kind === item ? "tiny active-kind" : "tiny"}
              type="button"
              onClick={() => {
                setKind(item);
                if (item === "file") void submit("file");
              }}
            >
              {item === "url" ? "URL" : item === "note" ? "Note" : "File"}
            </button>
          ))}
        </div>
        {kind !== "file" && (
          <input
            ref={field}
            value={value}
            placeholder={kind === "url" ? "https://…" : "Remember this…"}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeSheet();
            }}
          />
        )}
        <div className="actions">
          <button className="ghost" type="button" onClick={closeSheet}>
            Cancel
          </button>
          {kind !== "file" && (
            <button className="primary" type="submit" disabled={!value.trim()}>
              Add
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

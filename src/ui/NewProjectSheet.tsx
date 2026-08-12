import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";

export function NewProjectSheet() {
  const { sheet, createProject, closeSheet } = useStore();
  const [name, setName] = useState("");
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sheet === "project") {
      setName("");
      requestAnimationFrame(() => field.current?.focus());
    }
  }, [sheet]);

  if (sheet !== "project") return null;

  const submit = () => {
    createProject(name);
    closeSheet();
  };

  return (
    <div className="sheet-backdrop" onClick={closeSheet}>
      <form
        className="sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h3>New project</h3>
        <p>A name is enough. Link folders and other references later.</p>
        <input
          ref={field}
          value={name}
          placeholder="Untitled"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeSheet();
          }}
        />
        <div className="actions">
          <button className="ghost" type="button" onClick={closeSheet}>
            Cancel
          </button>
          <button className="primary" type="submit">
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import type { Session } from "../lib/types";

export function PlaceInProject({ session }: { session: Session }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="place-project" ref={root}>
      <span>This chat isn’t in a project.</span>
      {store.projects.length === 0 ? (
        <button type="button" onClick={() => store.openSheet("project")}>
          Create a project
        </button>
      ) : (
        <>
          <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            Add to a project
          </button>
          {open && (
            <div className="place-menu" role="menu">
              {store.projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    store.moveSession(session.id, project.id);
                    setOpen(false);
                  }}
                >
                  {project.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

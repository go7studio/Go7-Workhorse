import { useCallback, useEffect, useMemo, useState } from "react";
import { filterDeskSkills, skillBodyFromMarkdown } from "../lib/skills-catalog";
import { useStore } from "../lib/store";
import type { SkillOrigin } from "../lib/types";
import { MessageBody } from "./MessageBody";
import { McpServersPane } from "./McpServersPane";

const FILTERS: { id: "all" | SkillOrigin; label: string }[] = [
  { id: "all", label: "All" },
  { id: "grok", label: "Grok" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "cursor", label: "Cursor" },
  { id: "workhorse", label: "Workhorse" },
];

const PUSH: { id: Exclude<SkillOrigin, "workhorse">; label: string }[] = [
  { id: "grok", label: "Grok" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "cursor", label: "Cursor" },
];

const SKILL_PAGE_SIZE = 75;

export function SkillsPane() {
  const store = useStore();
  const skills = store.deskSkills;
  const listDeskSkills = store.listDeskSkills;
  const readDeskSkill = store.readDeskSkill;
  const [origin, setOrigin] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("Looking for skills…");
  const [openDir, setOpenDir] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [confirmDir, setConfirmDir] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(SKILL_PAGE_SIZE);

  const reload = useCallback(() => {
    void listDeskSkills().then((rows) => {
      setNote(rows.length === 0 ? "No skills found on this machine yet." : "");
    });
  }, [listDeskSkills]);

  useEffect(() => {
    reload();
  }, [reload]);

  const rows = useMemo(() => {
    const scoped = origin === "all" ? skills : skills.filter((skill) => skill.origin === origin);
    return filterDeskSkills(scoped, query);
  }, [origin, query, skills]);

  const selected = openDir ? skills.find((skill) => skill.dir === openDir) : undefined;
  const selectedManaged = selected?.managed === true;

  useEffect(() => {
    setVisibleCount(SKILL_PAGE_SIZE);
  }, [origin, query]);

  useEffect(() => {
    if (!openDir) {
      setBody("");
      return;
    }
    let live = true;
    void readDeskSkill(openDir).then((result) => {
      if (!live) return;
      setBody(result.skill?.text ?? result.message ?? "");
    });
    return () => {
      live = false;
    };
  }, [openDir, readDeskSkill]);

  const remove = (dir: string) => {
    void store.deleteDeskSkill(dir).then((result) => {
      setConfirmDir(null);
      setNote(result.message || (result.ok ? "Deleted." : "Could not delete."));
      if (result.ok) {
        if (openDir === dir) setOpenDir(null);
        reload();
      }
    });
  };

  if (selected) {
    return (
      <>
        <div className="link-head" style={{ marginBottom: 12 }}>
          <button className="tiny" type="button" onClick={() => setOpenDir(null)}>
            Back
          </button>
          <div className="actions">
            {PUSH.filter((item) => item.id !== selected.origin).map((item) => (
              <button
                key={item.id}
                className="tiny"
                type="button"
                onClick={() => {
                  void store.pushDeskSkill(selected.dir, item.id, selected.name).then((result) => {
                    setNote(result.message || (result.ok ? `Added to ${item.label}.` : "Could not add."));
                    if (result.ok) reload();
                  });
                }}
              >
                Add to {item.label}
              </button>
            ))}
            {selectedManaged && confirmDir === selected.dir ? (
              <button className="tiny danger" type="button" onClick={() => remove(selected.dir)}>
                Delete for good
              </button>
            ) : selectedManaged ? (
              <button className="tiny" type="button" onClick={() => setConfirmDir(selected.dir)}>
                Delete
              </button>
            ) : null}
          </div>
        </div>
        <div className="skill-detail">
          <div className="skill-detail-head">
            <span>
              <strong>{selected.name}</strong>
              <span className="row-meta">{selected.dir}</span>
            </span>
            <span className={`skill-origin ${selected.origin}`}>{labelFor(selected.origin)}</span>
          </div>
          {selected.description ? <p className="skill-detail-lead">{selected.description}</p> : null}
          {note ? <p className="row-meta">{note}</p> : null}
          <div className="skill-detail-body">
            <MessageBody text={skillBodyFromMarkdown(body) || "No write-up in this skill yet."} />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <McpServersPane />
      <div className="settings-section-divider" />
      <div className="link-head skills-heading">
        <strong>Skills</strong>
        <span className="row-meta">Reusable instructions from your agent homes and projects.</span>
      </div>
      <input
        className="settings-search"
        type="search"
        value={query}
        placeholder="Search by name, origin, or what it does"
        aria-label="Search skills"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="actions" style={{ marginBottom: 12 }}>
        {FILTERS.map((item) => (
          <button
            key={item.id}
            className={origin === item.id ? "tiny active-kind" : "tiny"}
            type="button"
            onClick={() => setOrigin(item.id)}
          >
            {item.label}
          </button>
        ))}
        <button
          className="tiny"
          type="button"
          onClick={() => {
            void store.importDeskSkill().then((result) => {
              if (result.canceled) return;
              setNote(result.message || (result.ok ? "Imported." : "Could not import."));
              if (result.ok) reload();
            });
          }}
        >
          Import
        </button>
      </div>
      {note && <p className="row-meta">{note}</p>}
      {rows.length === 0 && !note ? <p className="row-meta">No skills match that search.</p> : null}
      <ul className="skills-list">
        {rows.slice(0, visibleCount).map((skill) => (
          <li key={`${skill.origin}:${skill.dir}`} className="skill-row">
            <button className="skill-open" type="button" onClick={() => setOpenDir(skill.dir)}>
              <strong>{skill.name}</strong>
              {skill.description ? <em>{skill.description}</em> : null}
              <span className="row-meta">{skill.dir}</span>
            </button>
            <span className="skill-row-side">
              <span className={`skill-origin ${skill.origin}`}>{labelFor(skill.origin)}</span>
              {skill.managed === true && confirmDir === skill.dir ? (
                <button className="tiny danger" type="button" onClick={() => remove(skill.dir)}>
                  Delete for good
                </button>
              ) : skill.managed === true ? (
                <button className="tiny" type="button" onClick={() => setConfirmDir(skill.dir)}>
                  Delete
                </button>
              ) : (
                <span className="row-meta">Read-only here</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > visibleCount ? (
        <button
          className="tiny"
          type="button"
          onClick={() => setVisibleCount((count) => count + SKILL_PAGE_SIZE)}
        >
          Show more skills ({rows.length - visibleCount} remaining)
        </button>
      ) : null}
    </>
  );
}

function labelFor(origin: SkillOrigin): string {
  if (origin === "workhorse") return "Workhorse";
  if (origin === "codex") return "Codex";
  if (origin === "claude") return "Claude";
  if (origin === "cursor") return "Cursor";
  return "Grok";
}

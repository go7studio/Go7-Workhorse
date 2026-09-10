import { useMemo, useState, type ReactNode } from "react";
import type { PackDocuments, PackView } from "../lib/workshop-pack";

type CreateTemplate = {
  id: string;
  capability: string;
  label: string;
  fields: string[];
};

type CreateDoc = {
  allowed?: boolean;
  refuseReason?: string;
  templates?: CreateTemplate[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readCreate(documents: PackDocuments): CreateDoc | null {
  for (const [key, value] of Object.entries(documents)) {
    if (key === "status" || key === "desk") continue;
    if (!isRecord(value) || !isRecord(value.create)) continue;
    const create = value.create;
    const templatesRaw = create.templates;
    const templates: CreateTemplate[] = [];
    if (Array.isArray(templatesRaw)) {
      for (const row of templatesRaw) {
        if (!isRecord(row)) continue;
        const id = typeof row.id === "string" ? row.id : "";
        const capability = typeof row.capability === "string" ? row.capability : "";
        const label = typeof row.label === "string" ? row.label : id;
        const fields = Array.isArray(row.fields)
          ? row.fields.filter((field): field is string => typeof field === "string" && field.length > 0)
          : [];
        if (!id || !capability) continue;
        templates.push({ id, capability, label: label || id, fields });
      }
    }
    return {
      allowed: create.allowed === true,
      refuseReason: typeof create.refuseReason === "string" ? create.refuseReason : "",
      templates,
    };
  }
  return null;
}

/** True when any feed document publishes create.templates — generic; no pack id hardcoding. */
export function packOffersCreate(documents: PackDocuments): boolean {
  const create = readCreate(documents);
  return !!create && Array.isArray(create.templates) && create.templates.length > 0;
}

/**
 * Host-owned create form. Queues through Local Compute capability invoke.
 * Shown under any pack whose feed documents include create.templates.
 */
export function MediaCreatePanel({ pack }: { pack: PackView }): ReactNode {
  const create = useMemo(() => readCreate(pack.documents), [pack.documents]);
  const templates = create?.templates ?? [];
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const selected = templates.find((row) => row.id === templateId) ?? templates[0];
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!create || templates.length === 0) return null;

  const allowed = create.allowed === true;
  const refuseReason = create.refuseReason?.trim() || "Create is refused.";

  const onQueue = async () => {
    if (!selected || !allowed || !pack.hostId) return;
    setBusy(true);
    setMessage(null);
    try {
      const parsed: Record<string, string | number> = {};
      for (const name of selected.fields) {
        const raw = fields[name] ?? "";
        if (raw === "") continue;
        const asNum = Number(raw);
        parsed[name] = Number.isFinite(asNum) && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? asNum : raw;
      }
      const result = await window.workhorse?.localMediaCreate?.({
        hostId: pack.hostId,
        capability: selected.capability,
        templateId: selected.id,
        fields: parsed,
      });
      if (!result) {
        setMessage("Local Compute create is not available in this build.");
      } else if (result.ok) {
        setMessage(result.message);
      } else {
        setMessage(result.reason);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="media-create-panel" aria-label="Create">
      <div className="section-label">Create</div>
      {!allowed ? (
        <p className="media-create-refuse" role="status">
          {refuseReason}
        </p>
      ) : null}
      <label className="media-create-field">
        <span>Template</span>
        <select
          value={selected?.id ?? ""}
          disabled={!allowed || busy}
          onChange={(event) => {
            setTemplateId(event.target.value);
            setFields({});
            setMessage(null);
          }}
        >
          {templates.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
            </option>
          ))}
        </select>
      </label>
      {(selected?.fields ?? []).map((name) => (
        <label key={name} className="media-create-field">
          <span>{name}</span>
          <input
            type="text"
            value={fields[name] ?? ""}
            disabled={!allowed || busy}
            onChange={(event) => setFields((prev) => ({ ...prev, [name]: event.target.value }))}
          />
        </label>
      ))}
      <div className="media-create-actions">
        <button className="tiny" type="button" disabled={!allowed || busy || !selected || !pack.hostId} onClick={() => void onQueue()}>
          {busy ? "Queuing…" : "Queue"}
        </button>
        {!pack.hostId ? <span className="row-meta">Grant a host first</span> : null}
      </div>
      {message ? <p className="row-meta media-create-message">{message}</p> : null}
    </div>
  );
}

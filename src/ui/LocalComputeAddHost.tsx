import { useMemo, useState } from "react";
import {
  draftToLocalComputeHost,
  localComputeDraftIssue,
  type LocalComputeHostDraft,
  type LocalComputeHostSettings,
} from "../lib/local-compute";
import { useStore } from "../lib/store";

const EMPTY_DRAFT: LocalComputeHostDraft = { id: "", label: "", baseUrl: "", tokenFile: "" };

/** One sentence per field, naming the fix rather than the failure. */
const ISSUE_COPY: Record<"id" | "baseUrl" | "tokenFile", string> = {
  id: "Give the host a short id — letters or digits first, then dot, dash or underscore.",
  baseUrl: "Address must be an https:// URL with no query and no sign-in details.",
  tokenFile: "Choose the private file that holds this host's bearer, by absolute path.",
};

/**
 * Add one Local Compute host. Shared by Settings → LLMs and the Workshop preflight, so a desk with
 * no host can be fixed where the refusal is read instead of in another section.
 *
 * Grants start empty on purpose: a new host authorizes no capability and no caller. The Workshop
 * read path needs only an enabled host and a readable credential file, so that posture is enough
 * for a pack to poll without handing the host anything else.
 */
export function LocalComputeAddHost({
  onAdded,
  onCancel,
}: {
  onAdded?: (host: LocalComputeHostSettings) => void;
  onCancel?: () => void;
}) {
  const store = useStore();
  const hosts = store.settings.localCompute.hosts;
  const [draft, setDraft] = useState<LocalComputeHostDraft>(EMPTY_DRAFT);

  const candidate = useMemo(() => draftToLocalComputeHost(draft), [draft]);
  const issue = useMemo(() => localComputeDraftIssue(draft), [draft]);
  const duplicate = candidate ? hosts.some((host) => host.id === candidate.id) : false;
  const started = Boolean(draft.id.trim() || draft.baseUrl.trim() || draft.tokenFile.trim());

  const status = duplicate
    ? "That host id is already in use."
    : candidate
      ? "Ready to add. Grants start off."
      : started && issue
        ? ISSUE_COPY[issue]
        : "Enter a valid HTTPS host and absolute token-file path.";

  const add = () => {
    if (!candidate || duplicate) return;
    store.updateLocalCompute({ version: 1, hosts: [...hosts, candidate], legacyEnvironmentFallback: false });
    setDraft(EMPTY_DRAFT);
    onAdded?.(candidate);
  };

  return (
    <div className="local-compute-add">
      <label>
        <span>Name</span>
        <input
          value={draft.label}
          placeholder="Render host"
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
        />
      </label>
      <label>
        <span>ID</span>
        <input
          value={draft.id}
          placeholder="render-host"
          onChange={(event) => setDraft({ ...draft, id: event.target.value })}
        />
      </label>
      <label>
        <span>Address</span>
        <input
          value={draft.baseUrl}
          placeholder="https://host.example/run"
          onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
        />
      </label>
      <label className="local-compute-token">
        <span>Token file</span>
        <input
          value={draft.tokenFile}
          placeholder="Choose a private token file"
          onChange={(event) => setDraft({ ...draft, tokenFile: event.target.value })}
        />
        <button
          className="tiny"
          type="button"
          onClick={() => void window.workhorse?.pickLocalComputeTokenFile?.().then((file) => {
            if (file) setDraft((current) => ({ ...current, tokenFile: file }));
          })}
        >
          Choose…
        </button>
      </label>
      <div className="local-compute-add-actions">
        <span>{status}</span>
        {onCancel ? (
          <button className="tiny" type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button className="tiny" type="button" disabled={!candidate || duplicate} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

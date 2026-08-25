import { useEffect, useMemo, useState } from "react";
import {
  advertisedLocalComputeContinuations,
  LOCAL_COMPUTE_CALLER_ROLES,
  localComputeContinuationKey,
  normalizeLocalComputeHost,
  staleLocalComputeContinuationGrants,
  toggleLocalComputeContinuationGrant,
  type LocalComputeContinuationGrant,
  type LocalComputeHostProbe,
  type LocalComputeHostSettings,
  type LocalComputeCallerRole,
} from "../lib/local-compute";
import { useStore } from "../lib/store";

const ROLE_LABEL: Record<LocalComputeCallerRole, { name: string; detail: string }> = {
  desk: { name: "Workhorse", detail: "Calls made by this desk" },
  "external-runtime": { name: "Connected apps", detail: "Outside apps and the workhorse command" },
  worker: { name: "Workers", detail: "Workhorse builder workers" },
  auditor: { name: "Auditors", detail: "Workhorse verification workers" },
};

type HostDraft = { id: string; label: string; baseUrl: string; tokenFile: string };

const EMPTY_DRAFT: HostDraft = { id: "", label: "", baseUrl: "", tokenFile: "" };

function probeLabel(probe: LocalComputeHostProbe | undefined): string {
  if (!probe) return "Not checked";
  if (probe.status === "healthy") return "Healthy";
  if (probe.status === "disabled") return "Disabled";
  if (probe.status === "misconfigured") return "Needs setup";
  return "Unavailable";
}

export function LocalComputeBlock() {
  const store = useStore();
  const settings = store.settings.localCompute;
  const [draft, setDraft] = useState<HostDraft>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState("");
  const [probes, setProbes] = useState<Record<string, LocalComputeHostProbe>>({});

  const probe = async () => {
    const run = window.workhorse?.probeLocalCompute;
    if (!run) {
      setNote("Host checks run in the Workhorse desktop window.");
      return;
    }
    setChecking(true);
    const results = await run(settings.hosts);
    setProbes(Object.fromEntries(results.map((result) => [result.hostId, result])));
    setChecking(false);
    setNote(results.length ? "" : "Add a host to discover its capabilities.");
  };

  useEffect(() => {
    if (settings.hosts.length) void probe();
    // Hosts are rechecked deliberately after edits so typing never starts network work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const candidate = useMemo(
    () => normalizeLocalComputeHost({
      ...draft,
      enabled: true,
      allowedCallerRoles: [],
      allowedCapabilities: [],
      allowedContinuations: [],
    }),
    [draft],
  );
  const duplicate = candidate ? settings.hosts.some((host) => host.id === candidate.id) : false;

  const saveHosts = (hosts: LocalComputeHostSettings[]) => {
    store.updateLocalCompute({ version: 1, hosts, legacyEnvironmentFallback: false });
  };
  const replaceHost = (next: LocalComputeHostSettings) => {
    saveHosts(settings.hosts.map((host) => host.id === next.id ? next : host));
  };
  const toggleRole = (host: LocalComputeHostSettings, role: LocalComputeCallerRole) => {
    const roles = new Set(host.allowedCallerRoles);
    if (roles.has(role)) roles.delete(role);
    else roles.add(role);
    replaceHost({ ...host, allowedCallerRoles: [...roles] });
  };
  const toggleCapability = (host: LocalComputeHostSettings, capabilityId: string) => {
    const capabilities = new Set(host.allowedCapabilities);
    if (capabilities.has(capabilityId)) capabilities.delete(capabilityId);
    else capabilities.add(capabilityId);
    replaceHost({ ...host, allowedCapabilities: [...capabilities] });
  };
  const toggleContinuation = (host: LocalComputeHostSettings, continuation: LocalComputeContinuationGrant) => {
    replaceHost({
      ...host,
      allowedContinuations: toggleLocalComputeContinuationGrant(host.allowedContinuations, continuation),
    });
  };

  return (
    <div className="settings-group local-compute">
      <div className="settings-row settings-group-head">
        <div className="settings-row-copy">
          <strong>Local Compute</strong>
          <span>Execution hosts advertise typed capabilities. They are not vendors, bots, or Usage rings.</span>
          <span>Nothing is callable until both a caller role and an advertised capability are allowed.</span>
          {note ? <span className="settings-row-note">{note}</span> : null}
        </div>
        <div className="settings-control">
          <button className="tiny" type="button" onClick={() => setAdding((value) => !value)}>
            {adding ? "Cancel" : "Add host"}
          </button>
          <button className="tiny" type="button" disabled={checking || !settings.hosts.length} onClick={() => void probe()}>
            {checking ? "Checking…" : "Recheck"}
          </button>
        </div>
      </div>

      {adding ? (
        <div className="local-compute-add">
          <label>
            <span>Name</span>
            <input value={draft.label} placeholder="Render host" onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
          </label>
          <label>
            <span>ID</span>
            <input value={draft.id} placeholder="render-host" onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
          </label>
          <label>
            <span>Address</span>
            <input value={draft.baseUrl} placeholder="https://host.example/run" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
          </label>
          <label className="local-compute-token">
            <span>Token file</span>
            <input value={draft.tokenFile} placeholder="Choose a private token file" onChange={(event) => setDraft({ ...draft, tokenFile: event.target.value })} />
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
            <span>{duplicate ? "That host ID is already in use." : candidate ? "Ready to add. Grants start off." : "Enter a valid HTTPS host and absolute token-file path."}</span>
            <button
              className="tiny"
              type="button"
              disabled={!candidate || duplicate}
              onClick={() => {
                if (!candidate || duplicate) return;
                saveHosts([...settings.hosts, candidate]);
                setDraft(EMPTY_DRAFT);
                setAdding(false);
                setNote("Host added. Recheck it, then allow the capabilities and callers you want.");
              }}
            >
              Add
            </button>
          </div>
        </div>
      ) : null}

      {settings.hosts.length === 0 && !adding ? (
        <div className="settings-row local-compute-empty">
          <div className="settings-row-copy"><span>No local execution hosts.</span></div>
        </div>
      ) : null}

      {settings.hosts.map((host) => {
        const health = host.enabled ? probes[host.id] : {
          hostId: host.id,
          status: "disabled" as const,
          checkedAt: Date.now(),
          capabilities: [],
        };
        const healthy = health?.status === "healthy";
        const advertisedIds = new Set(health?.capabilities.map((capability) => capability.id) ?? []);
        const staleGrants = host.allowedCapabilities.filter((capabilityId) => !advertisedIds.has(capabilityId));
        const advertisedContinuations = advertisedLocalComputeContinuations(health?.capabilities ?? []);
        const continuationGrantKeys = new Set(host.allowedContinuations.map(localComputeContinuationKey));
        const staleContinuationGrants = staleLocalComputeContinuationGrants(
          host.allowedContinuations,
          advertisedContinuations,
        );
        return (
          <div className={`local-compute-host${host.enabled ? "" : " off"}`} key={host.id}>
            <div className="local-compute-host-head">
              <div>
                <strong>{host.label}</strong>
                <span>{host.baseUrl}</span>
                <span title={host.tokenFile}>Token file · {host.tokenFile}</span>
              </div>
              <div className="settings-control">
                <span className={`status-chip${healthy ? " on" : ""}`} title={health?.message}>{probeLabel(health)}</span>
                <button className="tiny" type="button" onClick={() => replaceHost({ ...host, enabled: !host.enabled })}>
                  {host.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="tiny"
                  type="button"
                  onClick={() => {
                    saveHosts(settings.hosts.filter((item) => item.id !== host.id));
                    setProbes((current) => {
                      const copy = { ...current };
                      delete copy[host.id];
                      return copy;
                    });
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
            <div className="local-compute-grants">
              <div>
                <b>Allowed callers</b>
                <span className="agent-chips" role="group" aria-label={`${host.label} allowed callers`}>
                  {LOCAL_COMPUTE_CALLER_ROLES.map((role) => (
                    <button
                      className={`agent-chip${host.allowedCallerRoles.includes(role) ? " on" : ""}`}
                      key={role}
                      type="button"
                      aria-pressed={host.allowedCallerRoles.includes(role)}
                      title={ROLE_LABEL[role].detail}
                      onClick={() => toggleRole(host, role)}
                    >
                      {ROLE_LABEL[role].name}
                    </button>
                  ))}
                </span>
              </div>
              <div>
                <b>Advertised capabilities</b>
                {!healthy ? <span>Recheck a healthy host before granting capabilities.</span> : null}
                {health?.runtimeId ? <span>{health.runtimeId}{health.runtimeVersion ? ` · ${health.runtimeVersion}` : ""}</span> : null}
                {healthy && health.capabilities.length === 0 ? <span>No capabilities advertised.</span> : null}
                {health?.capabilities.map((capability) => (
                  <button
                    className={`local-capability${host.allowedCapabilities.includes(capability.id) ? " on" : ""}`}
                    key={capability.id}
                    type="button"
                    aria-pressed={host.allowedCapabilities.includes(capability.id)}
                    title={capability.description}
                    onClick={() => toggleCapability(host, capability.id)}
                  >
                    <strong>{capability.id}</strong>
                    <span>Profile {capability.profileId}</span>
                    <span>Outputs {capability.outputRoles.join(", ") || "none"}</span>
                  </button>
                ))}
                {staleGrants.map((capabilityId) => (
                  <button
                    className="local-capability on stale"
                    key={capabilityId}
                    type="button"
                    aria-pressed="true"
                    title="This saved grant is not currently advertised and is not callable. Select it to remove the grant."
                    onClick={() => toggleCapability(host, capabilityId)}
                  >
                    <strong>{capabilityId}</strong>
                    <span>Not currently advertised</span>
                    <span>Not callable · select to remove</span>
                  </button>
                ))}
                <b className="local-capability-family">Continuation capabilities</b>
                {!healthy ? <span>Recheck a healthy host before granting continuations.</span> : null}
                {healthy && advertisedContinuations.length === 0 ? <span>No continuations advertised.</span> : null}
                {advertisedContinuations.map((continuation) => {
                  const granted = continuationGrantKeys.has(localComputeContinuationKey(continuation));
                  return (
                    <button
                      className={`local-capability${granted ? " on" : ""}`}
                      key={localComputeContinuationKey(continuation)}
                      type="button"
                      aria-pressed={granted}
                      title={`Continues ${continuation.sourceCapabilityIds.join(", ")}`}
                      onClick={() => toggleContinuation(host, continuation)}
                    >
                      <strong>{continuation.capability}</strong>
                      <span>Tool {continuation.tool}</span>
                      <span>Outputs {continuation.outputRoles.join(", ") || "none"}</span>
                    </button>
                  );
                })}
                {staleContinuationGrants.map((continuation) => (
                  <button
                    className="local-capability on stale"
                    key={localComputeContinuationKey(continuation)}
                    type="button"
                    aria-pressed="true"
                    title="This saved continuation grant is not currently advertised and is not callable. Select it to remove the grant."
                    onClick={() => toggleContinuation(host, continuation)}
                  >
                    <strong>{continuation.capability}</strong>
                    <span>Tool {continuation.tool}</span>
                    <span>Not callable · select to remove</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

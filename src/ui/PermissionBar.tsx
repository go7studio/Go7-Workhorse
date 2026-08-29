import { modeLabel, sandboxLabel } from "../lib/commands";
import { describeElevation } from "../lib/permissions";
import { providerById } from "../lib/providers";
import { deskInk, vendorLabel } from "../lib/settings";
import { useStore } from "../lib/store";
import { formatPermissionDetail, permissionActionLabel } from "../lib/tool-labels";

export function PermissionCard() {
  const { pending, answerPermission, sessions, settings } = useStore();
  const request = pending.find((item) => item.kind !== "vendor");
  if (!request) return null;

  const provider = providerById(request.provider);
  const child = sessions.find((item) => item.id === request.sessionId);
  const stock = request.provider !== "custom" ? settings.llms[request.provider] : undefined;
  const label =
    request.provider !== "custom"
      ? vendorLabel(request.provider, stock)
      : settings.customBots.find((bot) => bot.id === child?.customBotId)?.name ?? provider.name;
  const tint = child ? deskInk(child, settings) : undefined;
  const who = child?.hidden || child?.agentRun ? `${label} subagent` : label;
  const elevate = request.kind === "elevate" && request.elevate;
  const campaign = request.kind === "campaign" && request.campaign;
  const action = permissionActionLabel(request.tool);
  const detail = elevate
    ? [
        child && request.elevate ? describeElevation(child, request.elevate) : "",
        formatPermissionDetail(request.detail, request.path),
      ]
        .filter(Boolean)
        .join(" — ")
    : formatPermissionDetail(request.detail, request.path);
  const nextMode = request.elevate?.mode ? modeLabel(request.elevate.mode) : null;
  const nextBox = request.elevate?.sandbox ? sandboxLabel(request.elevate.sandbox) : null;

  return (
    <div
      className={`palette-overlay permission-overlay${elevate || campaign ? " elevate-overlay" : ""}`}
      role="dialog"
      aria-modal="true"
    >
      <div className={`permission-card${elevate || campaign ? " elevate-card" : ""}`}>
        <div className="session-who">
          <span className={`dot ${request.provider}`} style={tint ? { background: tint } : undefined} />
          <span className="eyebrow">{campaign ? "Campaign gate" : elevate ? `${label} · Elevate` : `${label} · Ask`}</span>
        </div>
        <strong>{campaign ? `Approve ${request.campaign?.phase} phase` : elevate ? `${who} needs more access` : `${who} wants to ${action}`}</strong>
        {detail ? <span className="permission-detail">{detail}</span> : null}
        <div className="actions">
          <button className="tiny deny" type="button" onClick={() => answerPermission(request.id, "deny")}>
            {campaign ? "Stop" : "Deny"}
          </button>
          {campaign ? (
            <button className="primary" type="button" onClick={() => answerPermission(request.id, "session")}>Approve phase</button>
          ) : elevate ? (
            <button className="primary" type="button" onClick={() => answerPermission(request.id, "session")}>
              {nextMode && nextBox ? `Elevate to ${nextMode} · ${nextBox}` : "Elevate"}
            </button>
          ) : (
            <>
              <button className="ghost" type="button" onClick={() => answerPermission(request.id, "once")}>
                Allow once
              </button>
              <button className="primary" type="button" onClick={() => answerPermission(request.id, "session")}>
                Allow for session
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

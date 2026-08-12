import { providerById } from "../lib/providers";
import { useStore } from "../lib/store";

export function PermissionBar() {
  const { pending, answerPermission } = useStore();
  const request = pending[0];
  if (!request) return null;

  const provider = providerById(request.provider);

  return (
    <footer className="permission">
      <div>
        <strong>
          {provider.name} wants to {request.tool}
        </strong>
        <span>
          {request.detail}
          {request.path ? ` · ${request.path}` : ""}
        </span>
      </div>
      <div className="actions">
        <button className="tiny deny" type="button" onClick={() => answerPermission(request.id, "deny")}>
          Deny
        </button>
        <button className="ghost" type="button" onClick={() => answerPermission(request.id, "once")}>
          Allow once
        </button>
        <button className="primary" type="button" onClick={() => answerPermission(request.id, "session")}>
          Allow for session
        </button>
      </div>
    </footer>
  );
}

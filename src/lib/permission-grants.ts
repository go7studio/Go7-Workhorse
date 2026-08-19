import { uid } from "./id";
import type { PermissionGrant } from "./types";

/** Migrate only exact, unexpired leases. Legacy family grants were too broad to preserve safely. */
export function normalizePermissionGrants(raw: unknown, now = Date.now()): PermissionGrant[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const grants = raw.flatMap((item): PermissionGrant[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Partial<PermissionGrant>;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    const tool = typeof row.tool === "string" ? row.tool.trim() : "";
    const detail = typeof row.detail === "string" ? row.detail.trim() : "";
    const createdAt = typeof row.createdAt === "number" ? row.createdAt : 0;
    const expiresAt = typeof row.expiresAt === "number" ? row.expiresAt : 0;
    if (!key || !tool || expiresAt <= now) return [];
    return [{
      id: typeof row.id === "string" && row.id.trim() ? row.id.trim() : uid("grant"),
      key,
      tool,
      detail,
      ...(typeof row.path === "string" && row.path.trim() ? { path: row.path.trim() } : {}),
      createdAt,
      expiresAt,
    }];
  });
  return grants.length ? grants : undefined;
}

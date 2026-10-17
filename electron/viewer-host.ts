import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Annotation } from "../src/lib/viewer";
import { previewFormat } from "../src/lib/viewer";
import type { PeerAsk, PeerAskResult } from "./peer-inbox";

export type ViewerRequest = {
  id: string;
  sessionId: string;
  operation: "load" | "clear" | "sync" | "snapshot";
  assetPath?: string;
};
export type ViewerCapture = { x: number; y: number; width: number; height: number };
export type ViewerReply = {
  id: string;
  sessionId: string;
  ok: boolean;
  error?: string;
  assetPath?: string;
  capture?: ViewerCapture;
  annotations?: Annotation[];
};
export const VIEWER_MAX_ANNOTATIONS = 1000;
export const VIEWER_MAX_ANNOTATION_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}
function vector(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n));
}
export function assertViewerSessionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error("Invalid preview chat id");
}
export function validateViewerAnnotations(value: unknown, sessionId: string): Annotation[] {
  assertViewerSessionId(sessionId);
  if (!Array.isArray(value) || value.length > VIEWER_MAX_ANNOTATIONS) throw new Error("Too many or invalid preview annotations");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > VIEWER_MAX_ANNOTATION_BYTES) throw new Error("Preview annotations are too large");
  const ids = new Set<string>();
  for (const item of value) {
    const ann = record(item);
    const asset = record(ann.asset);
    if (ann.schema !== "workhorse.annotation/v0" || !string(ann.id, 160) || !ann.id || ids.has(ann.id) ||
        ann.chatId !== sessionId || !string(ann.note, 8192) || !string(ann.createdAt, 64) || !Number.isFinite(Date.parse(ann.createdAt)) ||
        !Number.isInteger(ann.mark) || Number(ann.mark) < 1 || Number(ann.mark) > 1_000_000 ||
        !["3d-point", "3d-region", "2d-point", "2d-rect", "2d-lasso"].includes(String(ann.kind)) ||
        !string(asset.uri, 16_384) || !asset.uri || !["glb", "gltf", "obj", "fbx", "png", "jpg"].includes(String(asset.format))) {
      throw new Error("Invalid preview annotation");
    }
    ids.add(ann.id);
    if (String(ann.kind).startsWith("3d-")) {
      const target = record(ann.target);
      if (!string(target.objectName, 4096) || !string(target.objectPath, 8192) || !vector(target.worldPoint, 3) ||
          (target.localPoint !== undefined && !vector(target.localPoint, 3)) ||
          (target.worldNormal !== undefined && !vector(target.worldNormal, 3)) ||
          (target.uv != null && !vector(target.uv, 2))) throw new Error("Invalid preview 3D target");
    } else {
      const region = record(ann.region2d);
      if (!vector(region.imageSize, 2) || !(region.imageSize as number[]).every((n) => n > 0) ||
          (region.px !== undefined && !vector(region.px, 2)) || (region.rect !== undefined && !vector(region.rect, 4)) ||
          (region.polygon !== undefined && (!Array.isArray(region.polygon) || region.polygon.length > 4096 || !region.polygon.every((v) => vector(v, 2))))) {
        throw new Error("Invalid preview image target");
      }
    }
    if (ann.camera !== undefined) {
      const camera = record(ann.camera);
      if (!vector(camera.position, 3) || !vector(camera.quaternion, 4) || !vector(camera.viewport, 2) ||
          typeof camera.fovDeg !== "number" || !Number.isFinite(camera.fovDeg)) throw new Error("Invalid preview camera");
    }
    if (ann.screen !== undefined && !vector(record(ann.screen).px, 2)) throw new Error("Invalid preview screen point");
  }
  return value as Annotation[];
}

function safeDirectory(parent: string, name: string): string {
  const directory = path.join(parent, name);
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) {
    throw new Error("Preview storage must be a local directory without symlinks");
  }
  return directory;
}
function rootDirectory(userData: string): string {
  return fs.realpathSync(userData);
}
function regularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Preview storage file is not a regular file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export function createViewerAnnotationStore(userData: string) {
  const location = (sessionId: string) => {
    assertViewerSessionId(sessionId);
    return path.join(safeDirectory(rootDirectory(userData), "viewer-annotations"), `${sessionId}.json`);
  };
  return {
    save(sessionId: string, value: unknown): boolean {
      const annotations = validateViewerAnnotations(value, sessionId);
      const file = location(sessionId);
      regularFile(file);
      const scratch = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(scratch, JSON.stringify(annotations), { flag: "wx", mode: 0o600 });
        fs.renameSync(scratch, file);
      } finally {
        if (fs.existsSync(scratch)) fs.unlinkSync(scratch);
      }
      return true;
    },
    load(sessionId: string): Annotation[] {
      const file = location(sessionId);
      if (!regularFile(file)) return [];
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        if (fs.fstatSync(fd).size > VIEWER_MAX_ANNOTATION_BYTES) throw new Error("Preview annotations are too large");
        return validateViewerAnnotations(JSON.parse(fs.readFileSync(fd, "utf8")), sessionId);
      } finally { fs.closeSync(fd); }
    },
  };
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
export function viewerSession(state: unknown, sessionId: unknown, caller?: string): Record<string, unknown> {
  assertViewerSessionId(sessionId);
  if (caller && caller !== sessionId) throw new Error("Preview tools can only address their own chat");
  const sessions = record(state).sessions;
  const session = Array.isArray(sessions) ? sessions.map(record).find((s) => s.id === sessionId && !s.archivedAt) : undefined;
  if (!session) throw new Error("Preview chat does not exist");
  return session;
}
export function viewerSessionRoots(state: unknown, sessionId: string): string[] {
  const session = viewerSession(state, sessionId);
  const environment = record(session.environment);
  if (environment.kind === "cloud") throw new Error("Local preview cannot read a cloud chat's files");
  const projects = record(state).projects;
  const project = Array.isArray(projects) ? projects.map(record).find((p) => p.id === session.projectId) : undefined;
  const folders = project && Array.isArray(project.folders) ? project.folders.map(record).map((f) => f.path) : [];
  const candidates = environment.kind === "worktree" ? [environment.path] : folders;
  return candidates.filter((p): p is string => typeof p === "string" && path.isAbsolute(p)).flatMap((p) => {
    try { return fs.statSync(p).isDirectory() ? [fs.realpathSync(p)] : []; } catch { return []; }
  });
}
export function resolveViewerAsset(state: unknown, sessionId: string, assetPath: unknown): string {
  if (typeof assetPath !== "string" || !path.isAbsolute(assetPath) || assetPath.includes("\0") || /^[\\/]{2}/.test(assetPath)) {
    throw new Error("Preview needs an absolute local file path");
  }
  const roots = viewerSessionRoots(state, sessionId);
  const real = fs.realpathSync(assetPath);
  if (!roots.some((root) => contained(root, real))) throw new Error("Preview file is outside this chat's project folder");
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) throw new Error("Preview needs a regular file no larger than 256 MiB");
  return real;
}

/** Resolve missing watch directories without following a workspace symlink outside the chat. */
export function resolveViewerWatchFolder(state: unknown, sessionId: string, folder: string): string {
  if (!path.isAbsolute(folder) || /^[\\/]{2}/.test(folder)) throw new Error("Preview watch needs a local project folder");
  let nearest = path.resolve(folder);
  const missing: string[] = [];
  while (true) {
    try { fs.lstatSync(nearest); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(nearest);
      if (parent === nearest) throw new Error("Preview watch folder is unavailable");
      missing.unshift(path.basename(nearest));
      nearest = parent;
    }
  }
  const resolved = path.join(fs.realpathSync(nearest), ...missing);
  if (!viewerSessionRoots(state, sessionId).some((root) => resolved === path.join(root, ".workhorse", "preview"))) {
    throw new Error("Preview watch is outside this chat's preview folder");
  }
  return resolved;
}

export function createViewerHost(options: {
  userData: string;
  readState: () => unknown;
  send: (request: ViewerRequest) => void;
  capture: (rect: ViewerCapture) => Promise<Buffer>;
  timeoutMs?: number;
}) {
  const annotations = createViewerAnnotationStore(options.userData);
  const busy = new Set<string>();
  let disposed = false;
  const waiters = new Map<string, { sessionId: string; resolve: (reply: ViewerReply) => void; timer: ReturnType<typeof setTimeout> }>();
  const request = (sessionId: string, operation: ViewerRequest["operation"], assetPath?: string, timeoutMs = options.timeoutMs ?? 30_000) => new Promise<ViewerReply>((resolve, reject) => {
    if (disposed) { reject(new Error("Preview window closed")); return; }
    const id = randomUUID();
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error("Preview did not finish the request; open this chat's preview and try again"));
    }, timeoutMs);
    waiters.set(id, { sessionId, resolve, timer });
    try { options.send({ id, sessionId, operation, ...(assetPath ? { assetPath } : {}) }); }
    catch (error) { clearTimeout(timer); waiters.delete(id); reject(error); }
  });
  return {
    annotations,
    reply(value: unknown): boolean {
      const reply = record(value);
      if (typeof reply.id !== "string") return false;
      const pending = waiters.get(reply.id);
      if (!pending || reply.sessionId !== pending.sessionId || typeof reply.ok !== "boolean") return false;
      clearTimeout(pending.timer);
      waiters.delete(reply.id);
      pending.resolve(reply as ViewerReply);
      return true;
    },
    dispose() {
      disposed = true;
      for (const [id, pending] of waiters) {
        clearTimeout(pending.timer);
        pending.resolve({ id, sessionId: pending.sessionId, ok: false, error: "Preview window closed" });
      }
      waiters.clear();
    },
    async handle(ask: PeerAsk): Promise<PeerAskResult> {
      let owned = false;
      const sessionId = ask.toSessionId;
      const deadline = Date.now() + (options.timeoutMs ?? 30_000);
      const remainingMs = () => Math.max(1, deadline - Date.now());
      const askRenderer = (operation: ViewerRequest["operation"], assetPath?: string) => request(sessionId, operation, assetPath, remainingMs());
      try {
        const state = options.readState();
        viewerSession(state, sessionId, ask.fromSessionId);
        if (!ask.fromSessionId) throw new Error("Preview tools need their calling chat id");
        if (disposed) throw new Error("Preview window closed");
        if (busy.has(sessionId)) throw new Error("This chat's preview is handling another request; retry when it finishes");
        busy.add(sessionId);
        owned = true;
        if (ask.viewerOperation === "annotations" && !ask.clear) {
          const reply = await askRenderer("sync");
          if (!reply.ok) throw new Error(reply.error || "Preview did not synchronize its annotations");
          const rows = validateViewerAnnotations(reply.annotations, sessionId);
          annotations.save(sessionId, rows);
          return { text: JSON.stringify({ sessionId, annotations: rows, count: rows.length }) };
        }
        if (ask.viewerOperation === "load") {
          const assetPath = resolveViewerAsset(state, sessionId, ask.assetPath);
          const reply = await askRenderer("load", assetPath);
          if (!reply.ok || reply.assetPath !== assetPath) throw new Error(reply.error || "Preview did not load the requested file");
          return { text: JSON.stringify({ ok: true, sessionId, assetPath, format: previewFormat(assetPath) }) };
        }
        if (ask.viewerOperation === "annotations" && ask.clear === true) {
          const reply = await askRenderer("clear");
          if (!reply.ok) throw new Error(reply.error || "Preview did not clear its annotations");
          const rows = validateViewerAnnotations(reply.annotations, sessionId);
          annotations.save(sessionId, []);
          return { text: JSON.stringify({ sessionId, annotations: rows, count: rows.length, cleared: true }) };
        }
        if (ask.viewerOperation !== "snapshot") throw new Error("Unknown preview operation");
        const directory = safeDirectory(safeDirectory(rootDirectory(options.userData), "viewer-snapshots"), sessionId);
        const output = ask.outputPath ? path.resolve(ask.outputPath) : path.join(directory, `${randomUUID()}.png`);
        if (path.dirname(output) !== directory || path.extname(output).toLowerCase() !== ".png") {
          throw new Error("Preview snapshots must be PNGs in this chat's viewer-snapshots directory");
        }
        if (regularFile(output)) throw new Error("Preview snapshot already exists; choose a new name");
        const reply = await askRenderer("snapshot");
        const rect = reply.capture;
        if (!reply.ok || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
            rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.width > 16_384 || rect.height > 16_384) {
          throw new Error(reply.error || "Preview is not visible for a snapshot");
        }
        let captureTimer: ReturnType<typeof setTimeout> | undefined;
        let bytes: Buffer;
        try {
          bytes = await Promise.race([
            options.capture({ x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) }),
            new Promise<never>((_resolve, reject) => {
              captureTimer = setTimeout(() => reject(new Error("Preview capture timed out")), remainingMs());
            }),
          ]);
        } finally { if (captureTimer) clearTimeout(captureTimer); }
        // Selection changes can be ahead of the persisted desk. The renderer
        // confirms the visible chat both before and after the native capture.
        const confirmed = await askRenderer("snapshot");
        if (!confirmed.ok || !confirmed.capture ||
            ["x", "y", "width", "height"].some((key) => confirmed.capture![key as keyof ViewerCapture] !== rect[key as keyof ViewerCapture]) ||
            confirmed.assetPath !== reply.assetPath) throw new Error(confirmed.error || "Preview changed during capture; try again");
        if (!bytes.length || bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new Error("Preview did not produce a PNG snapshot");
        }
        const verifiedDirectory = safeDirectory(safeDirectory(rootDirectory(options.userData), "viewer-snapshots"), sessionId);
        if (verifiedDirectory !== directory) throw new Error("Preview storage changed during capture");
        fs.writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
        return { text: JSON.stringify({ ok: true, sessionId, path: output }) };
      } catch (error) { return { error: error instanceof Error ? error.message : "Preview request failed" }; }
      finally { if (owned) busy.delete(sessionId); }
    },
  };
}

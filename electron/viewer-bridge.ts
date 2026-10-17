import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ViewerReply, ViewerRequest } from "../src/lib/viewer";
import { isNetworkPath, safeLocalPath } from "./media-src";

/** Real paths stop a preview symlink from reaching outside the chat's workspace. */
export function viewerWorkspaceFile(cwd: string, file: string): string {
  if (!safeLocalPath(cwd) || !safeLocalPath(file) || !path.isAbsolute(cwd) || !path.isAbsolute(file)) {
    throw new Error("The viewer needs an absolute local workspace path");
  }
  const root = fs.realpathSync(cwd);
  const resolved = fs.realpathSync(file);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The preview file must stay inside this chat's workspace");
  }
  if (!fs.statSync(resolved).isFile()) throw new Error("The preview path is not a file");
  return resolved;
}

export function createViewerBridge(input: {
  send: (request: ViewerRequest) => void;
  capture: (rect: NonNullable<ViewerReply["rect"]>) => Promise<Buffer>;
  timeoutMs?: number;
}) {
  const pending = new Map<string, { resolve: (reply: ViewerReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  function request(sessionId: string, action: ViewerRequest["action"], extra: Partial<ViewerRequest> = {}): Promise<ViewerReply> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Open this chat in Workhorse to use its live preview"));
      }, input.timeoutMs ?? 10_000);
      pending.set(id, { resolve, reject, timer });
      try { input.send({ ...extra, id, sessionId, action }); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }
  return {
    reply(reply: ViewerReply): boolean {
      const waiter = pending.get(reply?.id);
      if (!waiter) return false;
      pending.delete(reply.id);
      clearTimeout(waiter.timer);
      if (reply.error) waiter.reject(new Error(reply.error));
      else waiter.resolve(reply);
      return true;
    },
    dispose() {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Workhorse window closed"));
      }
      pending.clear();
    },
    async call(name: string, args: Record<string, unknown>, from?: string): Promise<string> {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("A valid chat sessionId is required");
      if (from && from !== sessionId) throw new Error("A viewer tool can only access its own chat");
      const context = await request(sessionId, "context");
      if (!context.cwd) throw new Error("This chat has no workspace");
      if (name === "workhorse_viewer_load") {
        const file = typeof args.assetPath === "string" ? args.assetPath : "";
        const assetPath = viewerWorkspaceFile(context.cwd, file);
        if (!/\.(glb|gltf|png|jpe?g)$/i.test(assetPath)) throw new Error("Preview supports GLB, glTF, PNG and JPG");
        const loaded = await request(sessionId, "load", { assetPath });
        if (loaded.assetPath !== assetPath) throw new Error("The preview did not load that file");
        return JSON.stringify({ ok: true, sessionId, assetPath });
      }
      if (name === "workhorse_viewer_annotations") {
        const reply = await request(sessionId, "annotations", { clear: args.clear === true });
        if (!Array.isArray(reply.annotations)) throw new Error("The preview returned no annotations");
        return JSON.stringify({ sessionId, annotations: reply.annotations, count: reply.annotations.length });
      }
      if (name !== "workhorse_viewer_snapshot") throw new Error("Unknown viewer tool");
      const reply = await request(sessionId, "snapshot");
      const rect = reply.rect;
      if (!rect || !Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
        throw new Error("The preview is not visible");
      }
      const bytes = await input.capture(rect);
      if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error("The preview capture did not produce a PNG");
      }
      const root = fs.realpathSync(context.cwd);
      // A fresh file only: neither a user file nor a symlink is overwritten.
      const output = typeof args.outputPath === "string" && args.outputPath.trim()
        ? args.outputPath : path.join(root, `workhorse-preview-${randomUUID()}.png`);
      if (isNetworkPath(output) || output.includes("\0") || output.length > 4096 || !path.isAbsolute(output) || path.extname(output).toLowerCase() !== ".png") {
        throw new Error("Snapshot output must be an absolute local PNG path");
      }
      const parent = fs.realpathSync(path.dirname(output));
      const relative = path.relative(root, parent);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Snapshot output must stay inside this chat's workspace");
      }
      const target = path.join(parent, path.basename(output));
      fs.writeFileSync(target, bytes, { flag: "wx" });
      return JSON.stringify({ ok: true, sessionId, path: target, bytes: bytes.length });
    },
  };
}

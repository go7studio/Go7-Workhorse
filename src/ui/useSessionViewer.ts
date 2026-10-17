import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isValidAnnotation, previewAsset, previewFormat, type Annotation, type ViewerAsset } from "../lib/viewer";
import type { ViewerReply, ViewerRequest } from "../../electron/viewer-host";

/** Pins belong to a chat; only user edits write them, never the initial empty render. */
export function useSessionViewer(sessionId: string, cwd: string, previewUsed?: true) {
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState(sessionId);
  const [asset, setAsset] = useState<ViewerAsset | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(sessionId);
  active.current = sessionId;
  const state = useRef({ open, asset, annotations, ready });
  state.current = { open, asset, annotations, ready };
  const writes = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef<ViewerRequest | null>(null);
  const loaded = useRef(false);
  const reply = useCallback((request: ViewerRequest, value: Omit<ViewerReply, "id" | "sessionId">) => {
    void window.workhorse?.viewerReplyRequest?.({ id: request.id, sessionId: request.sessionId, ...value });
  }, []);
  const save = useCallback((id: string, next: Annotation[]) => {
    const write = writes.current.catch(() => {}).then(async () => {
      if (!await window.workhorse?.viewerSaveAnnotations?.(id, next)) throw new Error("Could not save preview marks.");
    });
    writes.current = write;
    void write.catch((failure: Error) => { if (active.current === id) setError(failure.message); });
    return write;
  }, []);
  useLayoutEffect(() => {
    setOwner(sessionId);
    setOpen(false); setAsset(null); setAnnotations([]); setReady(false); setError("");
    state.current = { open: false, asset: null, annotations: [], ready: false };
    loaded.current = false;
    if (pending.current) reply(pending.current, { ok: false, error: "The visible chat changed." });
    pending.current = null;
  }, [sessionId, reply]);
  useEffect(() => {
    let cancelled = false;
    if (!sessionId || state.current.ready) return;
    void writes.current.catch(() => {}).then(async () => {
      let rows: unknown[] = [];
      // A new chat reaches the main process through the existing deferred desk save.
      for (let attempt = 0; ; attempt += 1) {
        if (cancelled) return;
        try {
          rows = await window.workhorse?.viewerLoadAnnotations?.(sessionId) ?? [];
          break;
        } catch (failure) {
          if (attempt >= 6) throw failure;
          await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
        }
      }
      if (cancelled || active.current !== sessionId) return;
      const next = rows.filter(isValidAnnotation).filter((row) => row.chatId === sessionId);
      state.current.annotations = next; state.current.ready = true;
      setAnnotations(next); setReady(true);
    }).catch(() => { if (!cancelled) setError("Could not load preview marks. Reopen this chat to retry."); });
    return () => { cancelled = true; };
  }, [sessionId, previewUsed]);
  const openViewer = useCallback((next: ViewerAsset, request?: ViewerRequest) => {
    if (active.current !== sessionId) return;
    if (pending.current) reply(pending.current, { ok: false, error: "Another preview replaced this request." });
    pending.current = request ?? null;
    loaded.current = false;
    state.current.asset = next; state.current.open = true;
    setAsset(next); setOpen(true);
  }, [sessionId, reply]);
  const close = useCallback(() => {
    if (pending.current) reply(pending.current, { ok: false, error: "The preview was closed." });
    pending.current = null;
    state.current.open = false; loaded.current = false; setOpen(false);
  }, [reply]);
  const changeAnnotations = useCallback((next: Annotation[]) => {
    if (!state.current.ready) return;
    state.current.annotations = next; setAnnotations(next); setError("");
    void save(active.current, next);
  }, [save]);
  const addAnnotation = useCallback((annotation: Annotation) => {
    if (annotation.chatId !== active.current) return;
    changeAnnotations([...state.current.annotations, annotation]);
  }, [changeAnnotations]);
  const clearMarks = useCallback(() => {
    changeAnnotations(state.current.annotations.filter((row) => row.asset.uri !== state.current.asset?.uri));
  }, [changeAnnotations]);
  const onStatus = useCallback((status: "loaded" | "error", detail?: string) => {
    loaded.current = status === "loaded";
    const request = pending.current;
    if (!request || request.sessionId !== active.current || request.assetPath !== state.current.asset?.path) return;
    pending.current = null;
    reply(request, { ok: status === "loaded", assetPath: request.assetPath, ...(detail ? { error: detail } : {}) });
  }, [reply]);
  const openFile = useCallback(async () => {
    const id = active.current;
    const picked = await window.workhorse?.pickFile();
    if (!picked || active.current !== id) return;
    const [resolved, resolvedCwd] = await Promise.all([
      window.workhorse?.viewerResolveAsset?.(picked, cwd),
      cwd ? window.workhorse?.viewerResolveAsset?.(cwd) : null,
    ]);
    if (active.current !== id) return;
    const file = resolved || picked;
    const normalized = file.replace(/\\/g, "/");
    const root = (resolvedCwd || cwd).replace(/\\/g, "/").replace(/\/$/, "");
    const scopeRoot = root && normalized.startsWith(`${root}/`) ? root : normalized.replace(/\/[^/]*$/, "");
    openViewer({ ...previewAsset(file, previewFormat(file)), loadedAt: Date.now(), scopeRoot });
  }, [cwd, openViewer]);
  useEffect(() => window.workhorse?.onViewerRequest?.((request) => {
    const run = async () => {
      if (!sessionId || request.sessionId !== active.current) throw new Error("This chat is not visible.");
      await writes.current;
      if (request.sessionId !== active.current || !state.current.ready) throw new Error("Preview marks are still loading.");
      if (request.operation === "load") {
        if (!request.assetPath) throw new Error("No preview file was supplied.");
        openViewer({ ...previewAsset(request.assetPath, previewFormat(request.assetPath)), loadedAt: Date.now(), scopeRoot: request.scopeRoot }, request);
        return;
      }
      if (request.operation === "clear") {
        const cleared = state.current.annotations;
        changeAnnotations([]);
        await writes.current;
        if (request.sessionId !== active.current) throw new Error("The visible chat changed.");
        reply(request, { ok: true, annotations: cleared });
      } else if (request.operation === "sync") {
        reply(request, { ok: true, annotations: state.current.annotations });
      } else {
        const panel = document.querySelector<HTMLElement>(".session-viewer .viewer-panel");
        const rect = panel?.getBoundingClientRect();
        if (!state.current.open || !loaded.current || !rect?.width || !rect.height) throw new Error("Open a loaded preview in this chat first.");
        reply(request, { ok: true, assetPath: state.current.asset?.path, capture: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      }
    };
    void run().catch((failure: Error) => reply(request, { ok: false, error: failure.message }));
  }), [sessionId, cwd, reply, openViewer, changeAnnotations]);
  const show = useCallback(() => { state.current.open = true; setOpen(true); }, []);
  const refreshViewer = useCallback((next: ViewerAsset, initial = false) => {
    if (pending.current || (initial && state.current.asset)) return;
    openViewer(next);
  }, [openViewer]);
  return { open: owner === sessionId && open, asset, annotations, ready: owner === sessionId && ready, error, openViewer, refreshViewer, openFile, close, show, addAnnotation, clearMarks, onStatus };
}

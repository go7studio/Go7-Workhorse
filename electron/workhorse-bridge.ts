import http from "node:http";
import crypto from "node:crypto";
import { LINK_CHATS_MAX_BYTES, LINK_READ_MAX_BYTES, parseLinkReadPath, type LinkReadRequest } from "../src/lib/link-read";
import { authorizationBearer, tokensMatch } from "../src/lib/grok-bot-shim";
import type { PeerAsk, PeerAskResult } from "./peer-inbox";

export type { PeerAsk, PeerAskResult };

/** Request bound. A body over this is refused before it is held, never buffered whole. */
export const BRIDGE_MAX_BODY_BYTES = LINK_READ_MAX_BYTES;

/**
 * Transport ceiling on any reply. Each read route holds itself to a tighter
 * bound of its own; this is the backstop that stops any route, old or new,
 * writing without an end. Over it the caller gets the size, never a cut reply.
 */
export const BRIDGE_MAX_REPLY_BYTES = LINK_CHATS_MAX_BYTES;

export function bridgeReplyTooLarge(bytes: number, max = BRIDGE_MAX_REPLY_BYTES): { error: string } {
  return { error: `Workhorse bridge reply is ${bytes} bytes, over the ${max} byte bound. Ask for a smaller slice.` };
}

/**
 * Bounds on the socket, not on the work. A request has to arrive promptly; its
 * answer may take as long as the desk's longest wait, an hour for an awaited
 * spawn, and a minute past that. Without them a request that never got an
 * answer held its socket open for as long as the desk ran.
 */
export const BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
export const BRIDGE_IDLE_SOCKET_MS = (3_600 + 60) * 1_000;

export async function startWorkhorseBridge(
  handler: (ask: PeerAsk) => Promise<PeerAskResult>,
  bounds: { requestTimeoutMs?: number; idleSocketMs?: number } = {},
): Promise<{
  url: string;
  token: string;
  close: () => void;
}> {
  const token = crypto.randomBytes(16).toString("hex");
  const inflight = new Set<string>();
  const requestTimeout = bounds.requestTimeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS;
  const server = http.createServer({
    requestTimeout,
    headersTimeout: requestTimeout,
    connectionsCheckingInterval: Math.min(30_000, requestTimeout),
  }, (req, res) => {
    const pathName = req.url?.split("?")[0] ?? "";
    /**
     * Every answer goes out through here so no route can hand a helper an
     * unbounded body. Over the bound the caller gets an error object with the
     * size in it, because a truncated JSON reply is a lie a helper cannot see.
     */
    const send = (status: number, payload: unknown) => {
      const body = JSON.stringify(payload);
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > BRIDGE_MAX_REPLY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify(bridgeReplyTooLarge(bytes)));
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
    const read = req.method === "GET" && pathName.startsWith("/link/");
    if (!read && (req.method !== "POST" || (pathName !== "/ask" && pathName !== "/spawn" && pathName !== "/bots"))) {
      send(404, { error: "not found" });
      return;
    }
    // The token is checked before anything the caller sent is parsed. The read
    // path used to be decoded first, so `/link/chat/%E0` from anyone on this
    // machine threw inside the handler and left the socket open with no reply.
    if (!tokensMatch(token, authorizationBearer(req.headers.authorization))) {
      send(401, { error: "unauthorized" });
      return;
    }
    // Liveness, for a helper that holds a record of this bridge and needs to
    // know whether the desk that wrote it is still here. Nothing is asked of it.
    if (read && pathName === "/link/ping") {
      send(200, { ok: true });
      return;
    }
    let readRequest: LinkReadRequest | null = null;
    if (read) {
      try {
        readRequest = parseLinkReadPath(req.url ?? "");
      } catch {
        send(400, { error: "the read path is not valid URL encoding" });
        return;
      }
      if (!readRequest) {
        send(404, { error: "not found" });
        return;
      }
    }
    if (readRequest) {
      const from = new URLSearchParams(req.url?.split("?")[1] ?? "").get("from") ?? "";
      void (async () => {
        try {
          const result = await handler({
            toSessionId: "",
            fromSessionId: from,
            message: readRequest.id,
            mode: "bots",
            action: "link-read",
            name: readRequest.route,
            ...(readRequest.limit ? { limit: readRequest.limit } : {}),
          });
          send("error" in result && result.error ? 400 : 200, result);
        } catch (error) {
          send(500, { error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return;
    }
    // The refusal answers at once and the rest of the body is read and thrown
    // away. Dropping the socket instead leaves the caller holding a broken pipe
    // where it should be holding the reason.
    const declared = Number(req.headers["content-length"] ?? 0);
    const chunks: Buffer[] = [];
    let held = 0;
    let refused = Number.isFinite(declared) && declared > BRIDGE_MAX_BODY_BYTES;
    if (refused) {
      send(413, { error: `request body is ${declared} bytes, over the ${BRIDGE_MAX_BODY_BYTES} byte bound` });
    }
    req.on("data", (chunk) => {
      if (refused) return;
      held += (chunk as Buffer).length;
      if (held > BRIDGE_MAX_BODY_BYTES) {
        refused = true;
        chunks.length = 0;
        send(413, { error: `request body is over the ${BRIDGE_MAX_BODY_BYTES} byte bound` });
        return;
      }
      chunks.push(chunk as Buffer);
    });
    req.on("end", () => {
      if (refused) return;
      void (async () => {
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as PeerAsk & { prompt?: string };
          const bots = pathName === "/bots" || raw.mode === "bots";
          const spawn = !bots && (pathName === "/spawn" || raw.mode === "spawn");
          const action =
            raw.action === "create" ||
            raw.action === "delete" ||
            raw.action === "list" ||
            raw.action === "create-project" ||
            raw.action === "list-projects" ||
            raw.action === "move-chat" ||
            raw.action === "rename-chat" ||
            raw.action === "rename-project" ||
            raw.action === "delete-chat" ||
            raw.action === "delete-project" ||
            raw.action === "add-reference" ||
            raw.action === "list-references" ||
            raw.action === "delete-reference" ||
            raw.action === "select-project" ||
            raw.action === "record-write" ||
            raw.action === "request-permission" ||
            raw.action === "request-vendor" ||
            raw.action === "await-agents" ||
            raw.action === "plan" ||
            raw.action === "agent-status" ||
            raw.action === "cancel-agent" ||
            raw.action === "list-agents" ||
            raw.action === "list-external-agents" ||
            raw.action === "find-bots"
              ? raw.action
              : bots
                ? "list"
                : undefined;
          const body: PeerAsk = {
            ...raw,
            mode: bots ? "bots" : spawn ? "spawn" : raw.mode === "ask" ? "ask" : undefined,
            action,
            message: (raw.message || raw.prompt || (bots ? action ?? "list" : "")).trim(),
            toSessionId: raw.toSessionId ?? "",
            fromSessionId: raw.fromSessionId ?? "",
          };
          if (bots) {
            try {
              const result = await handler(body);
              send("error" in result ? 400 : 200, result);
            } catch (error) {
              send(500, { error: error instanceof Error ? error.message : String(error) });
            }
            return;
          }
          if (!body.message) {
            send(400, { error: spawn ? "prompt is required" : "toSessionId and message are required" });
            return;
          }
          if (!spawn && !body.toSessionId) {
            send(400, { error: "toSessionId and message are required" });
            return;
          }
          if (!spawn && body.fromSessionId && body.fromSessionId === body.toSessionId) {
            send(400, { error: "a chat cannot ask itself" });
            return;
          }
          const lockKey = spawn ? `spawn:${body.fromSessionId}:${body.message.slice(0, 24)}` : body.toSessionId;
          if (
            (!spawn && inflight.has(body.toSessionId)) ||
            (body.fromSessionId && !spawn && inflight.has(body.fromSessionId))
          ) {
            send(409, { error: "that chat is already answering another Workhorse chat" });
            return;
          }
          if (!spawn) inflight.add(body.toSessionId);
          if (body.fromSessionId && !spawn) inflight.add(body.fromSessionId);
          inflight.add(lockKey);
          try {
            const result = await handler(body);
            send("error" in result ? 400 : 200, result);
          } finally {
            inflight.delete(lockKey);
            if (!spawn) inflight.delete(body.toSessionId);
            if (body.fromSessionId && !spawn) inflight.delete(body.fromSessionId);
          }
        } catch (error) {
          send(500, { error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  });
  server.setTimeout(bounds.idleSocketMs ?? BRIDGE_IDLE_SOCKET_MS);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  if (!port) {
    server.close();
    throw new Error("Workhorse desk bridge did not bind a local port");
  }
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => server.close(),
  };
}

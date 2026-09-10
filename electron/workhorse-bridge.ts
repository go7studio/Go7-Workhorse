import http from "node:http";
import crypto from "node:crypto";
import { LINK_CHATS_MAX_BYTES, LINK_READ_MAX_BYTES, parseLinkReadPath } from "../src/lib/link-read";
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

export async function startWorkhorseBridge(handler: (ask: PeerAsk) => Promise<PeerAskResult>): Promise<{
  url: string;
  token: string;
  close: () => void;
}> {
  const token = crypto.randomBytes(16).toString("hex");
  const inflight = new Set<string>();
  const server = http.createServer((req, res) => {
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
    const readRequest = req.method === "GET" ? parseLinkReadPath(req.url ?? "") : null;
    if (!readRequest && (req.method !== "POST" || (pathName !== "/ask" && pathName !== "/spawn" && pathName !== "/bots"))) {
      send(404, { error: "not found" });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: "unauthorized" });
      return;
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
            raw.action === "list-external-agents"
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

import http from "node:http";
import crypto from "node:crypto";
import type { PeerAsk, PeerAskResult } from "./peer-inbox";

export type { PeerAsk, PeerAskResult };

export async function startWorkhorseBridge(handler: (ask: PeerAsk) => Promise<PeerAskResult>): Promise<{
  url: string;
  token: string;
  close: () => void;
}> {
  const token = crypto.randomBytes(16).toString("hex");
  const inflight = new Set<string>();
  const server = http.createServer((req, res) => {
    const pathName = req.url?.split("?")[0] ?? "";
    if (req.method !== "POST" || (pathName !== "/ask" && pathName !== "/spawn" && pathName !== "/bots")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
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
            raw.action === "await-agents"
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
              res.writeHead("error" in result ? 400 : 200, { "content-type": "application/json" });
              res.end(JSON.stringify(result));
            } catch (error) {
              res.writeHead(500, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            }
            return;
          }
          if (!body.message) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: spawn ? "prompt is required" : "toSessionId and message are required" }));
            return;
          }
          if (!spawn && !body.toSessionId) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "toSessionId and message are required" }));
            return;
          }
          if (!spawn && body.fromSessionId && body.fromSessionId === body.toSessionId) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "a chat cannot ask itself" }));
            return;
          }
          const lockKey = spawn ? `spawn:${body.fromSessionId}:${body.message.slice(0, 24)}` : body.toSessionId;
          if (
            (!spawn && inflight.has(body.toSessionId)) ||
            (body.fromSessionId && !spawn && inflight.has(body.fromSessionId))
          ) {
            res.writeHead(409, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "that chat is already answering another Workhorse chat" }));
            return;
          }
          if (!spawn) inflight.add(body.toSessionId);
          if (body.fromSessionId && !spawn) inflight.add(body.fromSessionId);
          inflight.add(lockKey);
          try {
            const result = await handler(body);
            res.writeHead("error" in result ? 400 : 200, { "content-type": "application/json" });
            res.end(JSON.stringify(result));
          } finally {
            inflight.delete(lockKey);
            if (!spawn) inflight.delete(body.toSessionId);
            if (body.fromSessionId && !spawn) inflight.delete(body.fromSessionId);
          }
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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

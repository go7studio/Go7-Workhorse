import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { nodeGetJson } from "../electron/claude-plan";

/*
 * The Claude usage read goes through Node's https client, which has no timeout
 * of its own. A server that accepted the connection and then said nothing held
 * the read, and the ring waiting on it, for as long as the socket stayed open.
 */
test("a usage read from a server that never answers gives up on its own", async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    // Accept, then say nothing at all: not even the TLS handshake.
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  let guard: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      nodeGetJson(`https://127.0.0.1:${port}/api/oauth/usage`, {}, 200).then(
        () => "answered",
        (error: Error) => error.message,
      ),
      new Promise<string>((resolve) => {
        guard = setTimeout(() => resolve("still waiting"), 5_000);
      }),
    ]);
    assert.match(outcome, /timed out after 200 ms/);
  } finally {
    if (guard) clearTimeout(guard);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

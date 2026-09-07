import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorSessionHost } from "../electron/cursor-host";
import { detectCursorLogin } from "../electron/cursor-login";
import { fetchCursorLedgerEvents, judgeCursorLedgerJoin } from "../electron/cursor-plan";
import type { GrokIpcEvent } from "../electron/grok-host";
import { estimateTurnTokens, joinCursorLedgerEvents } from "../src/lib/usage";

const POLL_MS = 120_000;
const POLL_EVERY_MS = 5_000;
const TURN_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(work: Promise<T>, label: string, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

const detection = detectCursorLogin();
if (!detection.connected) throw new Error("Cursor is not connected; no live ledger probe was made.");

const started = Date.now();
const markerA = `WH_LEDGER_A_${started}`;
const markerB = `WH_LEDGER_B_${started}`;
const smokeCwd = mkdtempSync(join(tmpdir(), "workhorse-cursor-ledger-"));
const host = new CursorSessionHost();
const eventsA: GrokIpcEvent[] = [];
const eventsB: GrokIpcEvent[] = [];

function promptFor(sessionId: string, marker: string, sink: GrokIpcEvent[]) {
  return host.prompt(
    {
      sessionId,
      model: "composer-2.5",
      effort: "low",
      mode: "ask",
      sandbox: "read-only",
      cwd: smokeCwd,
      text: `Connectivity ledger probe. Do not use tools or inspect files. Return exactly: ${marker}`,
      mcpServers: [],
      role: "orchestrator",
    },
    (event) => sink.push(event),
  );
}

try {
  const [resultA] = await Promise.all([
    withTimeout(promptFor("ledger-a", markerA, eventsA), "chat A", TURN_MS),
    withTimeout(promptFor("ledger-b", markerB, eventsB), "chat B", TURN_MS),
  ]);
  const vendorA = eventsA.find((event) => event.type === "vendor-session");
  const vendorB = eventsB.find((event) => event.type === "vendor-session");
  const vendorSessionA = vendorA?.type === "vendor-session" ? vendorA.vendorSessionId : "";
  const vendorSessionB = vendorB?.type === "vendor-session" ? vendorB.vendorSessionId : "";
  if (!vendorSessionA || !vendorSessionB) {
    throw new Error("Cursor did not prove a live vendor session for both chats.");
  }
  if (vendorSessionA === vendorSessionB) {
    throw new Error("Both chats received the same vendorSessionId.");
  }

  const estimateA = estimateTurnTokens(
    `Connectivity ledger probe. Do not use tools or inspect files. Return exactly: ${markerA}`,
    resultA.text,
  );
  const attempts: { path: string; status: number; keys: string[] }[] = [];
  const watchedFetch: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    let keys: string[] = [];
    try {
      const raw: unknown = await response.clone().json();
      keys = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw as object).sort() : [];
    } catch {
      keys = [];
    }
    const path = String(url).split("/").pop() ?? "";
    attempts.push({ path, status: response.status, keys });
    return response;
  };
  const fetchWindow = () =>
    fetchCursorLedgerEvents({
      startDate: started - 30_000,
      endDate: Date.now() + 60_000,
      fetchImpl: watchedFetch,
    });
  let ledger = await fetchWindow();
  const deadline = Date.now() + POLL_MS;
  while (ledger && Date.now() < deadline) {
    const judged = judgeCursorLedgerJoin({
      events: ledger,
      vendorSessionIds: [vendorSessionA, vendorSessionB],
    });
    if (judged.verdict !== "NO_MATCH") break;
    await sleep(POLL_EVERY_MS);
    ledger = await fetchWindow();
  }

  if (ledger === undefined) {
    console.log(JSON.stringify({ verdict: "NO_MATCH", reason: "auth-missing", identifierFields: [], attempts }, null, 2));
    process.exit(1);
  }

  const judged = judgeCursorLedgerJoin({
    events: ledger,
    vendorSessionIds: [vendorSessionA, vendorSessionB],
  });
  const booked = joinCursorLedgerEvents({
    events: judged.verdict === "OTHER_MATCH" && judged.joinField
      ? (await fetchCursorLedgerEvents({
          startDate: started - 30_000,
          endDate: Date.now() + 60_000,
          idField: judged.joinField,
          fetchImpl: watchedFetch,
        })) ?? ledger
      : ledger,
    sessions: [
      { id: "ledger-a", vendorSessionId: vendorSessionA, model: "composer-2.5" },
      { id: "ledger-b", vendorSessionId: vendorSessionB, model: "composer-2.5" },
    ],
  });
  const spendA = booked.find((item) => item.sessionId === "ledger-a");
  const spendB = booked.find((item) => item.sessionId === "ledger-b");
  if (spendA && spendB && spendA.id === spendB.id) {
    throw new Error("Chat A's ledger event was also joined to chat B.");
  }
  const ledgerTokensA = spendA ? spendA.inputTokens + spendA.cacheReadTokens : 0;
  const estimateTokensA = estimateA.inputTokens + estimateA.outputTokens;

  console.log(
    JSON.stringify(
      {
        verdict: judged.verdict,
        joinField: judged.joinField,
        identifierFields: judged.identifierFields,
        vendorSessions: 2,
        eventList: ledger.length,
        joined: booked.length,
        cachePresent: Boolean((spendA?.cacheReadTokens ?? 0) > 0 || (spendB?.cacheReadTokens ?? 0) > 0),
        estimateSmallerThanLedger:
          spendA !== undefined && ledgerTokensA > estimateTokensA,
        attempts: attempts.slice(0, 12),
        chatA: spendA
          ? { in: spendA.inputTokens, cached: spendA.cacheReadTokens, out: spendA.outputTokens }
          : null,
        chatB: spendB
          ? { in: spendB.inputTokens, cached: spendB.cacheReadTokens, out: spendB.outputTokens }
          : null,
      },
      null,
      2,
    ),
  );

  if (judged.verdict === "NO_MATCH") process.exit(1);
  if (!spendA || !spendB) throw new Error("Joined rows did not cover both probe chats.");
} finally {
  host.disposeAll();
  rmSync(smokeCwd, { recursive: true, force: true });
}

process.exit(0);

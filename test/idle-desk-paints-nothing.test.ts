import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A desk that is doing nothing must paint nothing. `.is-idle` carried
 * `animation: horse-rest 6800ms ... infinite`, and the sidebar holds every
 * chat, so that was one running animation per row. Measured on 0.6.70 with 854
 * idle chats and no work running: renderer 23-43% CPU, GPU helper 12-42%,
 * falling to 0.1% and 0.0% when the window was hidden and returning to 32% and
 * 22% when it was restored. Nothing was computing. It was all paint.
 *
 * This is a stylesheet pin. The suite has no DOM harness that can mount a
 * ChatRow, so `document.getAnimations()` is not available to assert on; the
 * live check would be that call returning empty for a resting row.
 */

const ANIMATED_STATES = [".is-idle", ".is-failed", ".is-stopped"];

/** Stylesheet text, CRLF normalised so a Windows checkout reads the same. */
function styles(name: string): string {
  return readFileSync(path.join(ROOT, "src", "styles", name), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Every `selector { declarations }` block. Nested at-rules fall out as their
 * inner blocks, which is what we want: a rule inside `@media` is still a rule.
 */
function rules(css: string): { selector: string; body: string }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim(),
    body: match[2]!,
  }));
}

function deskStyles(): { selector: string; body: string }[] {
  return rules(`${styles("horse-status.css")}\n${styles("app.css")}`);
}

test("a chat at rest runs no animation", () => {
  const looping = deskStyles().filter(
    (rule) =>
      ANIMATED_STATES.some((state) => rule.selector.includes(state)) && /\binfinite\b/.test(rule.body),
  );

  assert.deepEqual(
    looping.map((rule) => rule.selector),
    [],
    "resting, failed and stopped are states a desk sits in, so a loop there is one animation per sidebar row",
  );
});

test("working and needs-you still move", () => {
  const horse = styles("horse-status.css");

  // The motion means something on these two, and there are few of them at once.
  assert.match(horse, /\.horse-status\.is-working\s*\{[^}]*\binfinite\b/);
  assert.match(horse, /\.horse-status\.is-needs-you\s*\{[^}]*\binfinite\b/);
  // Rest still parts into tiles when work starts. That is a transition, not a loop.
  assert.match(horse, /\.horse-cube\s*\{[^}]*transition:\s*transform/);
  assert.match(horse, /prefers-reduced-motion:\s*reduce/);
});

test("a sidebar horse is scaled, not zoomed", () => {
  const sidebar = deskStyles().filter((rule) => /\.chat-row\s+\.horse-status/.test(rule.selector));
  assert.ok(sidebar.length > 0, "the sidebar horse rule is gone, so this pin proves nothing");

  for (const rule of sidebar) {
    // zoom is a layout property: it resizes the used values of a row on every paint.
    assert.doesNotMatch(rule.body, /\bzoom\s*:/, `zoom is layout work per row: ${rule.selector}`);
  }
  assert.match(styles("horse-status.css"), /\.chat-row \.horse-status\s*\{[^}]*scale:\s*\.75/);
});

/**
 * The same change that stopped the desk painting at rest also slowed the peer
 * inbox from four reads a second to one every five seconds. That is the path a
 * chat takes to another chat when the bridge is down, and five seconds was long
 * enough to lose one: the desk's own peer round trip allows four seconds and
 * failed under load here, then on the macOS runner for an unrelated pull
 * request.
 *
 * The saving was not real. An empty readdir of that directory measures 0.0097ms
 * at p50 on this Mac, so the old rate cost 3.4 seconds of CPU in a day. The
 * scan is back where it was, and this proves the behaviour rather than the
 * number: with a watcher that never fires, a request still gets answered by the
 * scan alone.
 */
test("a peer ask is answered by the scan alone, even when the watch never fires", async () => {
  const { INBOX_SCAN_MS, watchPeerInbox } = await import("../electron/peer-inbox");
  assert.ok(INBOX_SCAN_MS <= 250, `a peer ask can sit for ${INBOX_SCAN_MS}ms before anything reads it`);

  const inbox = mkdtempSync(path.join(tmpdir(), "wh-inbox-scan-"));
  try {
    const scans: Array<() => void> = [];
    let answered: (message: string) => void = () => {};
    const handled = new Promise<string>((resolve) => {
      answered = resolve;
    });

    const stop = watchPeerInbox(
      inbox,
      async (ask) => {
        answered(ask.message);
        return { text: `got:${ask.message}` };
      },
      {
        // This watcher never reports a change, which is the case the scan is for.
        watch: () => ({ close: () => {}, on: () => {} }),
        schedule: (tick) => {
          scans.push(tick);
          return () => scans.splice(0, scans.length);
        },
      },
    );

    try {
      writeFileSync(
        path.join(inbox, "1.req.json"),
        JSON.stringify({ fromSessionId: "a", toSessionId: "b", message: "hi" }),
      );
      assert.equal(scans.length, 1, "the desk scheduled its own scan rather than trusting the watch");
      scans[0]!();
      assert.equal(await handled, "hi", "the scan alone reached the handler");
    } finally {
      stop();
    }
  } finally {
    rmSync(inbox, { recursive: true, force: true });
  }
});

/**
 * The caller polls for the answer against a deadline. It used to throw the
 * moment the deadline passed, without one last look, so an answer that landed
 * during the final sleep was thrown away as a timeout.
 */
test("an answer that lands as the deadline passes is still an answer", async () => {
  const { askViaInbox } = await import("../electron/peer-inbox");
  const inbox = mkdtempSync(path.join(tmpdir(), "wh-inbox-deadline-"));
  try {
    const asked = askViaInbox(inbox, { fromSessionId: "a", toSessionId: "b", message: "hi" }, 1);
    // The desk answers after the deadline has already gone.
    const request = readdirSync(inbox).find((name) => name.endsWith(".req.json"));
    assert.ok(request, "the ask left a request behind to answer");
    writeFileSync(path.join(inbox, request!.replace(/\.req\.json$/, ".res.json")), JSON.stringify({ text: "late" }));
    assert.equal(await asked, "late");
  } finally {
    rmSync(inbox, { recursive: true, force: true });
  }
});

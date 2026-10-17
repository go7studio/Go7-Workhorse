import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { agySkipsPermissions, buildAgyLaunchSpec, modelPinsEffort } from "../electron/agy-launch";
import { detectAgyLogin } from "../electron/agy-login";
import { AGY_USAGE_ARGS, readAgyPlan } from "../electron/agy-plan";
import { AgySessionHost, type AgyChild } from "../electron/agy-host";
import { parseAgyModelsOutput, parseAgyStreamLine } from "../src/lib/agy-stream";
import type { GrokIpcEvent } from "../electron/grok-host";

test("launch argv is a headless stream with the workspace and no secrets", () => {
  const spec = buildAgyLaunchSpec({
    model: "gemini-3.8-flash-high",
    effort: "low",
    cwd: "/tmp/work",
    mode: "ask",
    sandbox: "workspace",
    conversationId: "conv-1",
  });
  assert.equal(spec.command, "agy");
  assert.ok(spec.argv.includes("--add-dir"));
  assert.equal(spec.argv[spec.argv.indexOf("--add-dir") + 1], "/tmp/work");
  assert.deepEqual(spec.argv.slice(-6), ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "0"]);
  assert.equal(spec.argv.includes("--effort"), false);
  assert.equal(modelPinsEffort("gemini-3.8-flash-high"), true);
  assert.equal(spec.argv.includes("-p"), false);
  assert.equal(spec.argv.includes("acp"), false);
  assert.equal(spec.argv.includes("--sandbox"), true);
  assert.equal(spec.argv.includes("--dangerously-skip-permissions"), false);
  assert.equal(spec.argv[spec.argv.indexOf("--conversation") + 1], "conv-1");
  const joined = spec.argv.join(" ");
  assert.equal(/oauth|api[_-]?key|token/i.test(joined), false);
});

test("omitted mode is always-approve, and a tighter mode stays off the flag", () => {
  const ask = buildAgyLaunchSpec({ model: "gemini-3.1-pro-high", cwd: "/tmp/work", mode: "ask", sandbox: "off" });
  assert.equal(ask.argv.includes("--mode"), false);
  assert.equal(ask.argv.includes("--sandbox"), false);
  assert.equal(ask.argv.includes("--dangerously-skip-permissions"), false);
  assert.equal(agySkipsPermissions("ask"), false);
  const omitted = buildAgyLaunchSpec({ cwd: "/tmp/work" });
  assert.equal(omitted.model, "gemini-3.8-flash-high");
  assert.equal(omitted.argv.includes("--dangerously-skip-permissions"), true);
  assert.equal(agySkipsPermissions(undefined), true);
  const open = buildAgyLaunchSpec({
    model: "custom-gemini",
    effort: "high",
    cwd: "/tmp/work",
    mode: "always-approve",
    sandbox: "strict",
  });
  assert.equal(open.argv[open.argv.indexOf("--effort") + 1], "high");
  assert.equal(open.argv.includes("--dangerously-skip-permissions"), true);
  assert.equal(open.argv.includes("--sandbox"), true);
  const plan = buildAgyLaunchSpec({ cwd: "/tmp/work", mode: "plan" });
  assert.equal(plan.model, "gemini-3.8-flash-high");
  assert.equal(plan.argv.includes("--mode"), false);
  assert.equal(plan.argv.includes("--dangerously-skip-permissions"), false);
  const edits = buildAgyLaunchSpec({ cwd: "/tmp/work", mode: "accept-edits" });
  assert.equal(edits.argv.includes("--mode"), false);
  assert.equal(edits.argv.includes("--dangerously-skip-permissions"), false);
  assert.throws(() => buildAgyLaunchSpec({ cwd: "relative" }), /workspace folder/);
});

test("usage meter is a one-shot print, and login follows the parse", async () => {
  assert.equal(AGY_USAGE_ARGS.at(-2), "-p");
  assert.equal(AGY_USAGE_ARGS.at(-1), "/usage");
  assert.equal(AGY_USAGE_ARGS.includes("acp"), false);
  const missing = await detectAgyLogin({ env: { PATH: "/nowhere" }, homedir: "/nowhere", existsSync: () => false });
  assert.equal(missing.launchable, false);
  assert.equal(missing.needsAuth, false);
  assert.match(missing.launchBlocker ?? "", /agy/);
  const signedOut = await detectAgyLogin({
    env: { PATH: "/fake" },
    homedir: "/nowhere",
    existsSync: (file) => file === "/fake/agy",
    probe: () => "",
  });
  assert.equal(signedOut.binary, "/fake/agy");
  assert.equal(signedOut.connected, false);
  assert.equal(signedOut.needsAuth, true);
  assert.equal(signedOut.launchable, true);
  const plan = await readAgyPlan({
    command: "agy",
    spawn: async () => ({
      code: 0,
      stdout: JSON.stringify({
        command: {
          data: {
            groups: [
              { name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-12T00:00:00Z" }] },
            ],
          },
        },
      }),
    }),
  });
  assert.equal(plan?.leftPercent, 100);
  assert.ok(plan?.observedAt);
  const signedIn = await detectAgyLogin({
    env: { PATH: "/fake" },
    homedir: "/nowhere",
    existsSync: (file) => file === "/fake/agy",
    probe: async () =>
      JSON.stringify({
        command: { data: { groups: [{ name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.4 }] }] } },
      }),
  });
  assert.equal(signedIn.connected, true);
  assert.equal(signedIn.needsAuth, false);
});

test("stream lines and the model table parse the documented shapes", () => {
  const init = parseAgyStreamLine(
    '{"event":"init","conversation_id":"c3","init":{"cwd":"/tmp/work","permission_mode":"request-review"}}',
  );
  assert.equal(init.kind, "init");
  const text = parseAgyStreamLine(
    '{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hi"}}',
  );
  assert.deepEqual(text, { kind: "text", step: 3, state: "ACTIVE", delta: "Hi" });
  const tool = parseAgyStreamLine(
    '{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"output":"hi\\n"}}}',
  );
  assert.equal(tool.kind, "tool");
  if (tool.kind === "tool") assert.equal(tool.name, "run_command");
  const result = parseAgyStreamLine(
    '{"event":"result","result":{"conversation_id":"c3","status":"SUCCESS","response":"Hi","usage":{"input_tokens":10,"output_tokens":2,"cache_read_tokens":4,"total_tokens":12}}}',
  );
  assert.equal(result.kind, "result");
  if (result.kind === "result") {
    assert.equal(result.usage?.input, 10);
    assert.equal(result.usage?.cacheRead, 4);
  }
  assert.equal(parseAgyStreamLine("not json").kind, "ignore");
  const models = parseAgyModelsOutput("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\n");
  assert.deepEqual(models, [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }]);
});

test("a fake agy process returns text and does not bill the cumulative total twice", async () => {
  let child: FakeChild | undefined;
  const host = new AgySessionHost(
    () => {
      child = new FakeChild();
      return child;
    },
    (live) => {
      (live as FakeChild).killed = true;
    },
    "agy",
  );
  const events: GrokIpcEvent[] = [];
  const input = {
    sessionId: "sess",
    model: "gemini-3.8-flash-high",
    effort: "high" as const,
    cwd: "/tmp/work",
    mode: "ask" as const,
    text: "Say hi",
  };
  const first = host.prompt(input, (event) => events.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(child);
  const live = child!;
  assert.match(live.stdin.chunks.join(""), /"event":"user"/);
  assert.equal(live.stdin.chunks.join("").includes("image"), false);
  live.stdout.emit(
    "data",
    `${JSON.stringify({ event: "init", conversation_id: "conv-9", init: { cwd: "/tmp/work" } })}\n`,
  );
  live.stdout.emit(
    "data",
    `${JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello" } })}\n`,
  );
  live.stdout.emit(
    "data",
    `${JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Hello there" } })}\n`,
  );
  live.stdout.emit(
    "data",
    `${JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-9",
        status: "SUCCESS",
        response: "Hello",
        usage: { input_tokens: 10418, output_tokens: 589, cache_read_tokens: 8113, total_tokens: 11007 },
      },
    })}\n`,
  );
  const done = await first;
  assert.equal(done.text, "Hello");
  assert.equal(done.vendorSessionId, "conv-9");
  assert.equal(events.filter((event) => event.type === "chunk").length, 1);
  const usage = events.find((event) => event.type === "usage");
  assert.equal(usage?.type, "usage");
  if (usage?.type === "usage") {
    assert.equal(usage.provider, "gemini");
    assert.equal(usage.source, "turn");
    assert.equal(usage.inputTokens, 2305);
    assert.equal(usage.cacheReadTokens, 8113);
    assert.equal(usage.outputTokens, 589);
  }
  events.length = 0;
  const second = host.prompt({ ...input, text: "Again" }, (event) => events.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  live.stdout.emit(
    "data",
    `${JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "Again",
        usage: { input_tokens: 20000, output_tokens: 800, cache_read_tokens: 16000, total_tokens: 20800 },
      },
    })}\n`,
  );
  const again = await second;
  assert.equal(again.text, "Again");
  const next = events.find((event) => event.type === "usage");
  if (next?.type === "usage") {
    assert.equal(next.inputTokens, 9582 - 7887);
    assert.equal(next.outputTokens, 211);
    assert.notEqual(next.inputTokens, 20000 - 16000);
  } else {
    assert.fail("second turn did not report usage");
  }
  host.disposeAll();
});

class FakeChild extends EventEmitter implements AgyChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    chunks: [] as string[],
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
  };
  pid = 4242;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

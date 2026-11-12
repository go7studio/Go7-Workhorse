import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { nextPromptForReply } from "../src/lib/next-prompt";

const require = createRequire(import.meta.url);
const afterSign = require("../scripts/after-sign.cjs") as {
  helperSignArgs: (helper: string, authority: string) => string[];
  appResealArgs: (appPath: string, authority: string) => string[];
  signDictationAndReseal: (
    appPath: string,
    authority: string,
    io: {
      existsSync: (file: string) => boolean;
      run: (bin: string, args: string[], opts: { encoding: string }) => { status: number; stdout?: string; stderr?: string };
    },
  ) => boolean;
};

test("a refused release offers the next prompt", () => {
  const reply = [
    "The Mac apps were signed, then codesign --verify failed because a sealed resource was missing or invalid,",
    "so the release was refused.",
  ].join(" ");
  assert.equal(nextPromptForReply(reply), "Fix the release");
  assert.equal(nextPromptForReply("The installers did not publish."), "Fix the release");
  assert.equal(nextPromptForReply("The three check jobs failed for the same assertion."), "Fix the checks");
  assert.equal(nextPromptForReply("The pull request is red."), "Fix the checks");
  assert.equal(nextPromptForReply("101 passed, 0 failed."), undefined);
  assert.equal(nextPromptForReply(""), undefined);
});

test("signing the dictation helper reseals the app without --deep", () => {
  const app = path.join("/tmp", "Go7 Workhorse.app");
  const helper = path.join(app, "Contents", "Resources", "mac-dictation");
  const authority = "Developer ID Application: Example Studio LLC (TEAM123456)";
  const calls: string[][] = [];
  const resealed = afterSign.signDictationAndReseal(app, authority, {
    existsSync: (file) => file === helper,
    run: (_bin, args) => {
      calls.push(args);
      return { status: 0 };
    },
  });
  assert.equal(resealed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].at(-1), helper);
  assert.equal(calls[1].at(-1), app);
  assert.equal(calls[0].includes("--deep"), false);
  assert.equal(calls[1].includes("--deep"), false);
  assert.deepEqual(calls[1], afterSign.appResealArgs(app, authority));
  assert.ok(calls[1].includes("--options") && calls[1].includes("runtime"));
  assert.deepEqual(calls[0], afterSign.helperSignArgs(helper, authority));
});

test("a helper that does not sign does not reseal a broken app", () => {
  const app = "/tmp/Go7 Workhorse.app";
  let calls = 0;
  assert.throws(
    () => afterSign.signDictationAndReseal(app, "Developer ID Application: Example", {
      existsSync: () => true,
      run: () => {
        calls += 1;
        return { status: 1, stderr: "errSecInternalComponent" };
      },
    }),
    /Could not sign the dictation helper/,
  );
  assert.equal(calls, 1);
});

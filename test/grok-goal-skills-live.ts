import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGrokOneShot } from "../electron/grok-agent";
import { detectGrokLogin } from "../electron/grok-login";
import { prepareVendorSend } from "../src/lib/vendor-send";

function assertNoDeskRewrite(vendorText: string, label: string): void {
  if (vendorText.includes("ongoing Workhorse goal") || vendorText.includes("Use the installed skill")) {
    throw new Error(`${label} desk rewrite leaked: ${vendorText}`);
  }
}

const login = detectGrokLogin();
const goalPrep = prepareVendorSend({ provider: "grok", text: "/goal status" });
const skillsPrep = prepareVendorSend({ provider: "grok", text: "/skills" });
assertNoDeskRewrite(goalPrep.vendorText, "/goal status");
assertNoDeskRewrite(skillsPrep.vendorText, "/skills");
if (goalPrep.vendorText !== "/goal status") throw new Error(`expected /goal status, got ${goalPrep.vendorText}`);
if (skillsPrep.vendorText !== "/skills") throw new Error(`expected /skills, got ${skillsPrep.vendorText}`);

if (!login.connected || !login.binary || !existsSync(login.binary)) {
  console.log("SKIP: grok is not on PATH or not logged in");
  process.exit(0);
}

const cwd = path.join(os.tmpdir(), "wh-grok-goal-skills-live");
mkdirSync(cwd, { recursive: true });

const goal = await runGrokOneShot({
  model: process.env.GROK_LIVE_MODEL || "grok-4.6",
  effort: "low",
  cwd,
  mode: "always-approve",
  prompt: goalPrep.vendorText,
});
if (goal.text.includes("ongoing Workhorse goal")) {
  throw new Error("Grok reply looks like a Workhorse goal rewrite");
}

const skills = await runGrokOneShot({
  model: process.env.GROK_LIVE_MODEL || "grok-4.6",
  effort: "low",
  cwd,
  mode: "always-approve",
  prompt: skillsPrep.vendorText,
});
if (skills.text.includes("Use the installed skill")) {
  throw new Error("Grok /skills reply looks like a desk skill wrap");
}

console.log(
  JSON.stringify(
    {
      skip: false,
      binary: login.binary,
      sent: [goalPrep.vendorText, skillsPrep.vendorText],
      goalStop: goal.stopReason ?? null,
      goalText: goal.text.slice(0, 400),
      skillsStop: skills.stopReason ?? null,
      skillsText: skills.text.slice(0, 400),
    },
    null,
    2,
  ),
);

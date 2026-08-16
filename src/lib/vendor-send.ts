import { invokeSkillPrompt } from "./commands";
import {
  applyGoalCommand,
  applyGrokGoalMirror,
  goalVendorPrompt,
  parseGoalInput,
  parseGrokGoalLine,
  type GoalState,
} from "./goal";
import type { Command } from "./types";

export type VendorSendPrep = {
  vendorText: string;
  haltVendor: boolean;
  applyDeskGoal: boolean;
  skipVendor: boolean;
};

export function prepareVendorSend(input: {
  provider?: string | null;
  text: string;
  goal?: GoalState;
  match?: Command | null;
}): VendorSendPrep {
  const text = input.text.trim();
  if (input.provider === "grok") {
    const grokGoal = parseGrokGoalLine(text);
    if (grokGoal) {
      const halt = grokGoal.action === "pause" || grokGoal.action === "clear";
      const apply =
        grokGoal.action === "set" ||
        grokGoal.action === "pause" ||
        grokGoal.action === "resume" ||
        grokGoal.action === "clear";
      return { vendorText: text, haltVendor: halt, applyDeskGoal: apply, skipVendor: false };
    }
    return { vendorText: text, haltVendor: false, applyDeskGoal: false, skipVendor: false };
  }

  const deskGoal = parseGoalInput(text);
  if (deskGoal) {
    if (deskGoal.action === "pause" || deskGoal.action === "clear") {
      return { vendorText: text, haltVendor: true, applyDeskGoal: true, skipVendor: true };
    }
    if (deskGoal.action === "view") {
      return { vendorText: text, haltVendor: false, applyDeskGoal: false, skipVendor: true };
    }
    const nextGoal = applyGoalCommand(input.goal, text);
    if (!nextGoal || (deskGoal.action !== "set" && deskGoal.action !== "resume")) {
      return { vendorText: text, haltVendor: false, applyDeskGoal: true, skipVendor: true };
    }
    return {
      vendorText: goalVendorPrompt(nextGoal, deskGoal.action),
      haltVendor: false,
      applyDeskGoal: true,
      skipVendor: false,
    };
  }

  if (input.match?.run === "skill") {
    return {
      vendorText: invokeSkillPrompt(input.match, text),
      haltVendor: false,
      applyDeskGoal: false,
      skipVendor: false,
    };
  }

  return { vendorText: text, haltVendor: false, applyDeskGoal: false, skipVendor: false };
}

export function nextGoalForSend(
  provider: string | undefined,
  state: GoalState | undefined,
  text: string,
  applyDeskGoal: boolean,
): GoalState | undefined {
  if (!applyDeskGoal) return state;
  if (provider === "grok") return applyGrokGoalMirror(state, text);
  return applyGoalCommand(state, text);
}

export type HaltForwardPlan = "send-now" | "defer-until-cancelled-done" | "desk-halt-only";

/** Grok pause/clear on a live turn must wait for the cancelled done before prompting the slash. */
export function planHaltForward(input: {
  haltVendor: boolean;
  skipVendor: boolean;
  sessionStatus?: string | null;
}): HaltForwardPlan {
  if (!input.haltVendor) return "send-now";
  if (input.skipVendor) return "desk-halt-only";
  if (input.sessionStatus === "running" || input.sessionStatus === "needs-input") {
    return "defer-until-cancelled-done";
  }
  return "send-now";
}

export type VendorTerminalAction = "ignore" | "consume-halt-then-forward" | "apply";

export function vendorTerminalAction(input: {
  halted: boolean;
  eventType: string;
  eventAssistantId?: string;
  liveAssistantId?: string;
}): VendorTerminalAction {
  const terminal = input.eventType === "done" || input.eventType === "error";
  if (!terminal) return input.halted ? "ignore" : "apply";
  if (input.halted) return "consume-halt-then-forward";
  if (input.eventAssistantId && input.liveAssistantId && input.eventAssistantId !== input.liveAssistantId) {
    return "ignore";
  }
  return "apply";
}

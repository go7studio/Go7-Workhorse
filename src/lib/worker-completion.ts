import { reportLeavesWorkOpen, workerMissionOutcome } from "./subagents";

export const WORKER_COMPLETION_RULE = "Keep working on the assigned task until it is verified. Progress belongs in commentary, not a final reply. End your final report with Mission status: complete only after every requested check passes; otherwise use Mission status: continue or Mission status: blocked and explain what remains. Never treat a tool finishing or a partial milestone as the task finishing.";

/** A vendor turn ending is not evidence that the delegated task finished. */
export async function finishWorkerTask(input: {
  prompt: string;
  run: (prompt: string) => Promise<string>;
  stopped: () => boolean;
  maxContinuations?: number;
}): Promise<string> {
  let prompt = `${input.prompt}\n\n${WORKER_COMPLETION_RULE}`;
  let previous = "";
  const limit = input.maxContinuations ?? 8;
  for (let attempt = 0; ; attempt += 1) {
    if (input.stopped()) return "Mission status: blocked\nWorker was stopped before verification.";
    const report = await input.run(prompt);
    if (input.stopped()) return `${report}\n\nWorker stopped before verification.\nMission status: blocked`;
    const outcome = workerMissionOutcome(report);
    const completionText = report
      .replace(/\bno remaining work\b/gi, "nothing remains")
      .replace(/^\s*remaining work:\s*(?:none|nothing|0)\s*[.!]?\s*$/gim, "nothing remains");
    if (outcome === "blocked" || (outcome === "complete" && !reportLeavesWorkOpen(completionText))) return report;
    if (attempt >= limit || (attempt > 0 && report.trim() === previous)) {
      return `${report}\n\nCompletion was not verified. Worker stopped after ${attempt + 1} turns${report.trim() === previous ? " with a repeated reply" : " at the continuation limit"}.\nMission status: blocked`;
    }
    previous = report.trim();
    prompt = `The assigned task is still open. Continue the remaining work in this chat, then verify the original request. Do not send another progress-only final reply. If an external blocker prevents further work, describe it. If all work is already verified, give the evidence and declare completion.\n\n${WORKER_COMPLETION_RULE}`;
  }
}

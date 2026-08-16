# Go7 Workhorse v0.1.4 eval findings

Run: `2026-08-15-v0.1.4-minimax-m3-01`

Every live model prompt used MiniMax-M3 through MiniMax's OpenAI-compatible
surface. No Anthropic API, Grok, Codex, Claude, or Kimi model prompt was sent.
Stock harness checks were redacted, detection-only probes.

## Release blockers and highest-priority repairs

1. **WH-001 — MiniMax streamed tool arguments are executed before assembly.**
   Workhorse accepted the no-argument bot-list tool, then invoked ten streamed
   spawn calls without their later `prompt` fragments. No child was created.
   Accumulate OpenAI-compatible tool calls by id/index, join names and JSON
   arguments across chunks, validate once complete, and execute each call once.
2. **WH-002 — Skills ownership and deletion are ambiguous.** Settings exposes
   Delete beside vendor-managed and cached skill paths outside the project.
3. **WH-003 — Two high-severity dependency advisories remain.** Electron
   37.10.3 and transitive `extract-zip` are affected; update assessment must be
   kept separate from behavioral scoring.

## Product gaps observed

- Fresh launch has no reopenable Getting Started flow or recognized-harness
  inventory; detected Grok, Codex, and Claude appeared as `Off` in Add bot.
- The first custom streamed response after session start/restart duplicated;
  the loop-guard pause message also duplicated and left the goal visibly active.
- Live MiniMax turns recorded model identity but no session token-usage event.
- Portable command copy leaks provider ownership (`Grok sandbox`) and gives an
  incorrect `/providers` description.
- Markdown alters exact underscore-delimited technical output in the visible
  transcript.
- Watch says `Windows notification` on macOS; the mac artifact is unsigned;
  the renderer exceeds the 500 kB warning threshold.
- Release v0.1.4 required the eval branch's opt-in
  `WORKHORSE_USER_DATA_PATH` override to guarantee isolated user data.
- Basename-only source resolution stops after 800 scanned entries. Once the
  evidence tree grew, the final gate could no longer find
  `src/lib/project.ts`; the clean-state gate had passed all 215 tests, while
  the evidence-populated rerun passed 214/215.

## Confirmed strengths

- v0.1.4 built cleanly; the initial clean-state gate passed all 215 tests.
- Name-only projects, optional folder linking, model-after-chat selection,
  manual title locking, profile/settings persistence, and paused-goal restart
  persistence worked.
- MiniMax-M3 selection matched request, transcript model, and live identity;
  no silent model fallback was observed.
- The deterministic five-turn fixture reconciled exactly 85 input and 60
  output tokens, and duplicate visible text did not inflate usage.
- The repeated-tool loop guard stopped the orchestration failure without
  falsely completing the goal.
- The packaged v0.1.4 app launched from isolated state and its archive hash was
  recorded.

The complete reproduction details, screenshots, sanitized session records,
build/test logs, package hash, audit payload, and per-item verdicts remain in
the ignored run evidence directory.

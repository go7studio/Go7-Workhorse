# Performance

A handful of code paths in this desk run on every keystroke, every streamed
token, or every launch. Each one has an invariant and a test that enforces it.
This page names them so a change that crosses one is recognised as a change
rather than a slowdown someone notices months later.

The budgets in `test/performance.test.ts` are **tripwires for a complexity
class**, not benchmarks. They are deliberately loose, because the suite runs on
Linux, macOS and Windows runners of very different speeds. A number moving from
9 ms to 40 ms is fine. A number crossing its budget usually means a loop became
a nested loop, or a per-turn cost became a per-token cost.

## The hot paths

| Path | Invariant | Enforced by |
| --- | --- | --- |
| **Stream commit** | Streamed tokens coalesce to one desk commit per frame; done, cancel, and permission force a flush. A streamed token repaints the chat it belongs to, and nothing else — composer, context meter, watch bar, and Usage hold across prose growth. | `test/performance.test.ts` — "stream commits are bounded by frames, not tokens", "a streamed token does not commit the composer…", "the context meter settles on turn boundaries…", "a streamed chat cannot repaint the watch bar…", "the session pane paints its own chat…", "a streamed token does not commit Usage…" |
| **Hydrate** | Cleaning the usage log at launch is linear in the number of events. It used to be a cross product: 1.4 s at 10,000 events, inside `hydrate()`, before the window painted. | `test/performance.test.ts` — "collapsing ten thousand usage events stays off the boot path", "ten thousand events in one fast session do not reopen the cross product" |
| **Usage collapse correctness** | The bucketed collapse returns exactly what the cross product returned, in any log order. The old implementation is kept in the test as the oracle. | `test/performance.test.ts` — "bucketed usage collapse answers exactly what the cross product answered" |
| **Sidebar index** | The sidebar is built once per desk change, keeps worker nesting, and ignores streamed prose. A running chat holds the place it was sent in. | `test/performance.test.ts` — "large desks build one sidebar index…", "sidebar ignores streamed prose but sees visible status and tool changes", "three chats running at once keep the order they were sent in" |
| **Transcript grouping** | Only the live turn is regrouped; earlier blocks keep their identity, and the incremental result equals a full regroup. Older blocks fill one idle slice at a time. | `test/performance.test.ts` — "incremental transcript rebuilds only the live turn…", "sending a new prompt keeps earlier transcript blocks", "older transcript blocks fill one idle slice at a time" |
| **Scroll pin** | Following a stream reads and writes the scroller once per frame, not once per token, and leaving a chat drops the pending pin. | `test/performance.test.ts` — "a stream pins the transcript once a frame, not once a token" |
| **Persist** | Selecting a chat is not persist work. A selection-only change must compare equal, so typing and clicking do not journal the desk. | `test/performance.test.ts` — "selection-only desk updates do not look like persist work", "selecting a chat keeps the same sessions array when there is no draft" |
| **Project changes** | Reading a folder 400 times in one turn still resolves to the files that were written, within the first-click budget. | `test/performance.test.ts` — "project changes skip read tools and still see the write in a long scrape turn" |
| **Boot rewrite decision** | Deciding whether a launch must rewrite the state costs a walk that stops at the first difference, not two serialisations of the whole desk. The old compare was 155 ms on a 46 MB file, on the main process, before first paint, to answer "nothing changed". | `test/long-term-health.test.ts` — "the JSON walk answers exactly what the two stringify calls answered", "the walk stops at the first difference…" |
| **Backup rotation** | Copying the whole state file is a ten-minute job, not a one-minute one; the fsync keeps its own minute clock so durability does not ride on it. | `test/long-term-health.test.ts` — "two saves inside the cadence rotate once", "slowing the rotation did not slow the flush…" |

## How to keep it

Narrow subscriptions are the mechanism behind most of the table above.
`src/lib/store-select.ts` holds one equality function per surface, and a
component takes the smallest slice it can through `useStoreSelector`. A new
`useStore()` in a component that is visible while a chat streams will undo a
row of this table without failing anything, so prefer a selector and add its
equality to `test/performance.test.ts` in the same change.

Three habits cover the rest:

- **Measure before caching.** The markdown parser looked like the obvious
  per-token hot spot and is not: 0.29 ms for a 30 KB reply. The cost around a
  token is the commit, not the parse.
- **Watch for unbounded arrays in persisted state.** The usage log grows by one
  event per turn and is re-read on every launch. Any new list with that shape
  needs a plan for its size before it ships. Picture bytes do not belong in
  `workhorse-state.json`; they write once under `userData/attachments/`, named
  by their sha256, and the chat keeps a path. A blob is verified before the
  inline copy is cleared, and a picture that cannot be stored stays inline.
  Link helpers parse that file once per version, drop inline `data` while
  parsing, and reuse one snapshot for a whole RPC. A finished worker runtime
  is disposed; `vendorSessionId` stays so the next prompt can `session/load`.
  Enforced by `test/attachments.test.ts`,
  `test/attachment-store-safety.test.ts`, `test/link-state.test.ts`, and
  `test/workhorse.test.ts`. The store's plan for its own size: blobs are
  content-addressed so a repeated screenshot costs one file;
  `attachments/*.tmp-*` older than a day is swept by user-data-hygiene; blob
  garbage collection (deleting files no chat references) is deliberately not
  built yet — deleting a shared blob wrongly loses a picture, so it waits for
  a reference count, and until then the store grows with distinct pictures
  only.
  The same rule now covers the other thing that grew without a plan. A
  finished worker's thinking and tool rows write once to
  `userData/transcripts/<sessionId>.json` and the chat keeps a path; the prose
  and the final report stay inline, because that is what a person opens the
  chat to read. Measured on a year-old desk: 45.72 MB of state, 39.64 MB of it
  belonging to 624 workers whose runs had ended, thinking 16.37 MB and tool
  output 11.52 MB — 61% of a file that is parsed at every launch and serialised
  at every save. The sidecar is read back and counted before the inline rows are
  cleared, an unwritable one keeps them, and nothing is ever deleted: no cap, no
  trim, no collection, for the same reason blobs are not collected — that waits
  for a reference count. Only workers whose `agentRun.status` is terminal are
  touched, and `interrupted` is not terminal, because that is the desk stopping
  rather than the worker finishing. One save may write at most 25 sidecars
  (`TRANSCRIPT_OFFLOAD_PER_SAVE`), because each write flushes and the offload
  runs on the main loop before the save's first await — an unbounded first pass
  on a 624-worker desk is seconds of held loop spent fixing a stall. Opening a
  worker chat reads that one file and merges it back through
  `mergeTranscriptRows`; the chat carries `transcriptSidecar` and
  `transcriptOffloaded` until the rows are back, and dropping that pair early
  orphans the file. Enforced by `test/long-term-health.test.ts`.
- **Add the budget with the fix.** When a slow path is repaired, leave a test
  that fails if the old shape returns, with a comment saying what it cost.
- **A folder the desk creates needs someone who deletes it.** Managed worktrees
  had a sweep from the start, and the sweep was handed every session id as its
  live set. Hidden workers are sessions, so every tree named a chat that still
  existed and none was ever a candidate: 626 hidden rows, 624 of them finished,
  137 trees, 59 GB — 98% of `userData` — and a prune that had removed nothing in
  a year. Two things keep that from recurring. The live set is now finished
  workers minus an age floor (`worktreeKeepSet`), not the whole desk. And the
  folder has a stated ceiling in `user-data-hygiene.ts` that the boot line
  reports against, so its size is a number in the log rather than something
  found with `du` after a disk fills. Being a candidate still grants nothing:
  every refusal in `worktree-host.ts` runs on the tree itself.
- **Keep destructive work off the paint path.** The prune ran inside
  `state:load`, between the read and the reply, so every `git` call it made was
  a call the first frame waited on — and its two-second budget, sized for that
  position, cleared about ten trees a launch against a backlog of 137. It now
  runs on a timer well after the window, where the budget can be twenty seconds
  because there is nothing left to protect but the desk's own responsiveness.
  The thirty-day sweep of hand-named state backups sits there too.

## Measuring the running app

The budgets above are tripwires in Node. The desk also watches itself run, on
every launch: the main process records every event-loop stall over 250ms to
`userData/perf/heartbeat.jsonl` — a timestamp, the gap, a one-word cause
(`state:save`, `state:read`) and, where the work has a size, the bytes it was
moving. Never content. Launch with `WORKHORSE_PERF_TRACE=1` (or
`--workhorse-perf-trace`) to drop the threshold to 80ms when you are hunting
something specific. The flag used to decide whether to record at all, and a
person opening the app from Finder sets neither gate, so `userData/perf` had
never existed on a desk that had been running for a year — the one instrument
built to explain felt jank had measured nothing. Deciding the *threshold* keeps
the shipped build honest without filling the file. It rotates at 1 MB. The
instrument exists because the main process brokers every IPC message, so a
block there is felt on every surface at once and no renderer tooling can see
it. Two independent reviews traced the felt stall to the save pipeline and
named this recorder as the first thing to build; the save's disk half now runs
off-thread (`writeVersionedStateAsync`), and whether the remaining
clone-and-stringify half justifies incremental persistence is a question the
trace answers, not a guess. One reading rule: a cause word means that work
held the loop somewhere inside the gap's window, not that it caused the whole
gap — a tagged region overlapping the window's edge takes full blame, so treat
a single surprising row as a hint and a repeated one as evidence.

## On file size

`src/lib/store.tsx` is large, and a few other files are near it. Size is not
itself a bug and there is no line-count gate here — but a big file is where a
second home for one fact tends to appear, and that is a correctness problem.
When you are already inside one of these files, prefer routing through the
callback that exists over writing a second path beside it.

## Typechecking

`npm run build` typechecks the app (`tsconfig.json`) and the suite
(`tsconfig.test.json`) separately. The test project runs under `tsx`, so it
allows the `.ts`/`.tsx` import paths the suite actually uses; nothing is
emitted from either.

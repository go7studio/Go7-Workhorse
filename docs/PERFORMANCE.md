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
  needs a plan for its size before it ships.
- **Add the budget with the fix.** When a slow path is repaired, leave a test
  that fails if the old shape returns, with a comment saying what it cost.

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

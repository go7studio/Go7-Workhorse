import { boundWorkerReport } from "./subagents";
import type { WorkerFinding } from "./types";

/**
 * What a Link reply is allowed to carry.
 *
 * A delegate reply used to repeat the whole crew with each worker's full task
 * text, and every finished worker's whole report, on every call. One audit
 * parent answered in about 25 KB and sent the same 3,000-character mission
 * brief seven times in one reply: a mission names its workers after its
 * objective, so that brief was the title, and the title was the slice.
 *
 * The reply is a board, not an archive. It says who is out, what each one is
 * on in a few words, and how the last finished work ended. Counts say how much
 * the board is not showing, and the full text is one call away by id through
 * `workhorse_agent_status` or `workhorse_read_chat`.
 */

/** A crew slice is a label. Eighty characters is a line, not a brief. */
export const LINK_LABEL_CHARS = 80;

/** Live workers, plus this many of the most recent finished ones. */
export const LINK_FINISHED_KEEP = 5;

/** First characters of a finished report, then a pointer to the full text. */
export const LINK_REPORT_CHARS = 400;

export type LinkCrewMember = {
  worker: string;
  slice: string;
  status: string;
  free: boolean;
};

export type LinkFinishedRow = {
  title: string;
  status: string;
  report: string;
  childSessionId: string;
  error?: string;
  findings?: WorkerFinding[];
};

export type LinkLineup = {
  id?: string;
  folder?: string;
  running: string[];
  finished: LinkFinishedRow[];
};

export type LinkBoundedFinishedRow = LinkFinishedRow & {
  /** Present only when the title was cut; the full title is on the worker. */
  titleTruncated?: true;
  /** Present only when the report was cut; read the full one by id. */
  reportTruncated?: true;
};

export type LinkBoundedLineup = Omit<LinkLineup, "finished"> & {
  finished: LinkBoundedFinishedRow[];
  /** How many workers this lineup finished in all, listed or not. */
  finishedCount: number;
};

/** A label, cut to one line. Whitespace at the cut goes with it. */
export function linkLabel(value: string, chars = LINK_LABEL_CHARS): string {
  const trimmed = value.trim();
  return trimmed.length <= chars ? trimmed : trimmed.slice(0, chars).trimEnd();
}

/** Running or queued. Anything else has stopped and is history. */
export function linkCrewIsLive(member: Pick<LinkCrewMember, "status">): boolean {
  return member.status === "running" || member.status === "queued";
}

/**
 * Every live worker, plus the most recent finished ones. A parent that has run
 * 800 slices still has one board; `crewCount` is how many workers it has had.
 */
export function boundLinkCrew(
  crew: readonly LinkCrewMember[],
  keep = LINK_FINISHED_KEEP,
): { crew: LinkCrewMember[]; crewCount: number } {
  const rows = crew.map((member) => ({ ...member, slice: linkLabel(member.slice) }));
  const finished = rows.filter((member) => !linkCrewIsLive(member));
  const listed = new Set(finished.length > keep ? finished.slice(finished.length - keep) : finished);
  return {
    crew: rows.filter((member) => linkCrewIsLive(member) || listed.has(member)),
    crewCount: crew.length,
  };
}

/**
 * The lineup a reply carries: every running worker, the last few finished, and
 * a bounded report on each of those. `boundWorkerReport` writes the pointer to
 * the full text, so a caller that needs the whole report knows the tool and the
 * id to ask for it with.
 */
export function boundLinkLineup(
  lineup: LinkLineup,
  options?: { keep?: number; reportChars?: number },
): LinkBoundedLineup {
  const keep = options?.keep ?? LINK_FINISHED_KEEP;
  const reportChars = options?.reportChars ?? LINK_REPORT_CHARS;
  const kept = lineup.finished.length > keep ? lineup.finished.slice(lineup.finished.length - keep) : lineup.finished;
  return {
    ...lineup,
    running: lineup.running.map((title) => linkLabel(title)),
    finished: kept.map((row) => {
      const title = linkLabel(row.title);
      const bounded = boundWorkerReport(row.report, { workerId: row.childSessionId, limit: reportChars });
      return {
        ...row,
        title,
        ...(title === row.title.trim() ? {} : { titleTruncated: true as const }),
        report: bounded.report,
        ...(bounded.truncated ? { reportTruncated: true as const } : {}),
      };
    }),
    finishedCount: lineup.finished.length,
  };
}

/**
 * The crew and lineup a delegate or continuation reply publishes. One call so
 * the started reply and the completed reply cannot drift apart.
 */
export function boundLinkReply(input: { crew: readonly LinkCrewMember[]; lineup?: LinkLineup }): {
  crew: LinkCrewMember[];
  crewCount: number;
  lineup?: LinkBoundedLineup;
} {
  return {
    ...boundLinkCrew(input.crew),
    ...(input.lineup ? { lineup: boundLinkLineup(input.lineup) } : {}),
  };
}

/** Host output caps run 20–64 KB. Past this the CLI says so instead of cutting. */
export const LINK_CLI_MAX_BYTES = 64 * 1024;

export const LINK_CLI_OVERSIZE_ERROR = "output over 64 KB; use --parents or --limit";

export type LinkCliPage = { limit?: number; cursor?: number };

/**
 * A page of a CLI list, asked for by `--limit` and `--cursor`.
 *
 * Without either flag the output stays the bare array it has always been, so a
 * harness that reads `[0]` still does. With one, the rows come wrapped with the
 * cursor to ask for next — `null` when this page is the last.
 */
export function linkCliPageRows(rows: unknown[], page: LinkCliPage, maxBytes = LINK_CLI_MAX_BYTES): {
  rows: unknown[];
  cursor: number;
  nextCursor: number | null;
  rowCount: number;
} {
  const cursor = Number.isFinite(page.cursor) && page.cursor! > 0 ? Math.floor(page.cursor!) : 0;
  const limit = Number.isFinite(page.limit) && page.limit! > 0 ? Math.floor(page.limit!) : rows.length;
  const asked = rows.slice(cursor, cursor + limit);
  // A page the caller asked for can still be over the cap: 100 rows of a desk
  // whose workers are named after a long brief is a quarter of a megabyte. Fit
  // what the budget takes and point the cursor at the first row left out, so
  // paging always moves forward instead of failing on every limit the caller
  // tries. Row sizes are measured once, not by rebuilding the page each time.
  const overhead = JSON.stringify({ chats: [], cursor, nextCursor: rows.length, chatCount: rows.length }).length;
  const window: unknown[] = [];
  let used = overhead;
  for (const row of asked) {
    const size = Buffer.byteLength(JSON.stringify(row) ?? "null", "utf8") + 1;
    if (window.length > 0 && used + size > maxBytes) break;
    used += size;
    window.push(row);
  }
  const end = cursor + window.length;
  return { rows: window, cursor, nextCursor: end < rows.length ? end : null, rowCount: rows.length };
}

/**
 * What the CLI prints, bounded before it is printed.
 *
 * `paged` is set only for a subcommand that can page; anything else is passed
 * through. Output past the host cap becomes the error naming the two flags
 * that make it fit, never a document with its last string cut in half.
 */
export function linkCliOutput(
  text: string,
  options?: { paged?: boolean; page?: LinkCliPage; maxBytes?: number },
): { text: string; oversize: boolean } {
  const maxBytes = options?.maxBytes ?? LINK_CLI_MAX_BYTES;
  const page = options?.page ?? {};
  const asked = page.limit !== undefined || page.cursor !== undefined;
  let body = text;
  if (options?.paged && asked) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        const window = linkCliPageRows(parsed, page, maxBytes);
        body = JSON.stringify({
          chats: window.rows,
          cursor: window.cursor,
          nextCursor: window.nextCursor,
          chatCount: window.rowCount,
        });
      }
    } catch {
      /* not a list; pass it through and let the cap decide */
    }
  }
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    return { text: JSON.stringify({ error: LINK_CLI_OVERSIZE_ERROR }), oversize: true };
  }
  return { text: body, oversize: false };
}

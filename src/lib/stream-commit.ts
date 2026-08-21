/** Coalesce streamed token commits to one React flush per frame. */

import { upsertThoughtMessage } from "./grok-events";
import { mergeStreamedText } from "./markdown";
import type { Session } from "./types";
import type { FrameClock } from "./transcript-scroll";

export type { FrameClock };

/**
 * One desk commit per frame for streamed tokens. Chunks and thoughts land in
 * the per-session queues; `request` schedules at most one flush. `flushNow`
 * drains immediately so done / cancel / permission never lose a token.
 */
export function createStreamCommitScheduler(
  flush: () => void,
  clock: FrameClock,
): { request: () => void; flushNow: () => void; stop: () => void } {
  let handle = 0;
  let waiting = false;
  return {
    request() {
      if (waiting) return;
      waiting = true;
      handle = clock.frame(() => {
        waiting = false;
        handle = 0;
        flush();
      });
    },
    flushNow() {
      if (waiting) {
        clock.cancelFrame(handle);
        waiting = false;
        handle = 0;
      }
      flush();
    },
    stop() {
      if (waiting) clock.cancelFrame(handle);
      waiting = false;
      handle = 0;
    },
  };
}

export type StreamQueueDrain = {
  sessions: Session[];
  chunkQueue: Record<string, string>;
  thoughtQueue: Record<string, string>;
  changed: boolean;
};

/**
 * Move queued chunk/thought text into live assistant messages. When the
 * assistant row is not on the desk yet, the queues stay put for the send path.
 */
export function applyStreamQueues(input: {
  sessions: Session[];
  chunkQueue: Record<string, string>;
  thoughtQueue: Record<string, string>;
  assistantIdFor: (sessionId: string, session: Session) => string | undefined;
}): StreamQueueDrain {
  const chunkQueue = { ...input.chunkQueue };
  const thoughtQueue = { ...input.thoughtQueue };
  const sessionIds = new Set([...Object.keys(chunkQueue), ...Object.keys(thoughtQueue)]);
  if (sessionIds.size === 0) {
    return { sessions: input.sessions, chunkQueue, thoughtQueue, changed: false };
  }

  let changed = false;
  const sessions = input.sessions.map((session) => {
    if (!sessionIds.has(session.id)) return session;
    const assistantId = input.assistantIdFor(session.id, session);
    const hasMessage = Boolean(assistantId && session.messages.some((message) => message.id === assistantId));
    if (!hasMessage || !assistantId) return session;

    let messages = session.messages;
    let touched = false;
    const chunk = chunkQueue[session.id];
    if (chunk) {
      delete chunkQueue[session.id];
      messages = messages.map((message) =>
        message.id === assistantId ? { ...message, text: mergeStreamedText(message.text, chunk) } : message,
      );
      touched = true;
    }
    const thought = thoughtQueue[session.id];
    if (thought) {
      delete thoughtQueue[session.id];
      messages = upsertThoughtMessage(messages, thought);
      touched = true;
    }
    if (!touched) return session;
    changed = true;
    return { ...session, messages };
  });

  return { sessions, chunkQueue, thoughtQueue, changed };
}

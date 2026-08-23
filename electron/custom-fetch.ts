export const CUSTOM_CONNECT_TIMEOUT_MS = 120_000;
export const CUSTOM_DISCOVERY_TIMEOUT_MS = 10_000;
export const CUSTOM_PROBE_TIMEOUT_MS = 30_000;
export const CUSTOM_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;

type TimedAbort = {
  signal: AbortSignal;
  dispose: () => void;
  timedOut: () => boolean;
};

function timedAbort(parent: AbortSignal | null | undefined, timeoutMs: number): TimedAbort {
  const controller = new AbortController();
  let timeout = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error("Custom model request timed out."));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function redirectError(response: Response): Error | undefined {
  return response.status >= 300 && response.status < 400
    ? new Error("Custom endpoint redirects are not allowed.")
    : undefined;
}

/** Fetch response headers with a bounded connect/first-byte wait and no redirects. */
export async function fetchCustomResponse(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const deadline = timedAbort(init.signal, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, redirect: "manual", signal: deadline.signal });
    const redirect = redirectError(response);
    if (redirect) throw redirect;
    return response;
  } catch (error) {
    if (deadline.timedOut()) throw new Error("Custom model request timed out.");
    throw error;
  } finally {
    deadline.dispose();
  }
}

/** Keep the deadline active until a small probe/discovery body is consumed. */
export async function withCustomResponse<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const deadline = timedAbort(init.signal, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, redirect: "manual", signal: deadline.signal });
    const redirect = redirectError(response);
    if (redirect) throw redirect;
    return await consume(response);
  } catch (error) {
    if (deadline.timedOut()) throw new Error("Custom model request timed out.");
    throw error;
  } finally {
    deadline.dispose();
  }
}

/** Cancel an otherwise live stream when it stops producing bytes. */
export async function readCustomStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number = CUSTOM_STREAM_IDLE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timedOut = false;
  let aborted = false;
  const abortFromParent = () => {
    aborted = true;
    void reader.cancel(signal?.reason);
  };
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel("Custom model stream stalled.");
  }, timeoutMs);
  timer.unref?.();
  try {
    const result = await reader.read();
    if (aborted) throw signal?.reason ?? new Error("Custom model request cancelled.");
    if (timedOut) throw new Error("Custom model stream stalled.");
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

/** Read only a bounded diagnostic from an error response, with one total deadline. */
export async function readCustomErrorDetail(
  response: Response,
  signal?: AbortSignal,
  maxBytes: number = 400,
  timeoutMs: number = 10_000,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  let aborted = false;
  const abortFromParent = () => {
    aborted = true;
    void reader.cancel(signal?.reason);
  };
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel("Custom model error response timed out.");
  }, timeoutMs);
  timer.unref?.();
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (aborted) throw signal?.reason ?? new Error("Custom model request cancelled.");
      if (timedOut) throw new Error("Custom model error response timed out.");
      if (done) break;
      const kept = value.subarray(0, maxBytes - size);
      chunks.push(kept);
      size += kept.byteLength;
      if (kept.byteLength < value.byteLength || size >= maxBytes) {
        await reader.cancel("Custom model error detail limit reached.").catch(() => undefined);
        break;
      }
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

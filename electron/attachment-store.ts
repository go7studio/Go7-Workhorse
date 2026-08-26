import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatImage } from "../src/lib/types";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export function attachmentsDir(userData: string): string {
  return path.join(userData, "attachments");
}

function stripDataUrl(data: string): string {
  return data.replace(/^data:[^;]+;base64,/, "");
}

function insideDir(root: string, file: string): boolean {
  const parent = path.resolve(root);
  const target = path.resolve(file);
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function extFor(image: Pick<ChatImage, "mimeType" | "name">, fallbackPath = ""): string {
  const mime = (image.mimeType || "").toLowerCase();
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const named = path.extname(image.name || fallbackPath).replace(/^\./, "").toLowerCase();
  return named || "bin";
}

/** Base64 as a decoder will actually round-trip. Buffer.from silently drops junk. */
const BASE64_ONLY = /^[A-Za-z0-9+/\r\n]*={0,2}$/;

/**
 * Is the blob on disk the blob we meant to write?
 *
 * The filename is the sha256 of the content, so this is checkable rather than
 * assumed. It matters twice: an existing file may be a truncated leftover from
 * a killed write, and a fresh write may not have landed whole.
 */
function blobMatches(dest: string, hash: string, size: number): boolean {
  try {
    if (fs.statSync(dest).size !== size) return false;
    return crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex") === hash;
  } catch {
    return false;
  }
}

/**
 * Write bytes under their own hash, and return the path ONLY once the bytes are
 * verifiably there.
 *
 * The caller clears the inline copy on the strength of this answer, so a path
 * returned for a file that is short, wrong, or absent destroys the last copy of
 * someone's picture. There is no non-atomic fallback for that reason: if the
 * rename cannot be done, the honest answer is null and the bytes stay in state.
 */
function writeHashedBlob(userData: string, bytes: Buffer, ext: string): string | null {
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const dir = attachmentsDir(userData);
  const dest = path.join(dir, `${hash}.${ext}`);
  let temp = "";
  try {
    fs.mkdirSync(dir, { recursive: true });
    // An existing file is only good if it is actually this content.
    if (fs.existsSync(dest) && blobMatches(dest, hash, bytes.length)) return dest;
    temp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(temp, "w");
    try {
      fs.writeFileSync(fd, bytes);
      // Rename is atomic; it is not durable. Without this the directory entry
      // can outlive the contents across a crash and leave a zero-length blob.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, dest);
    temp = "";
    if (!blobMatches(dest, hash, bytes.length)) return null;
    return dest;
  } catch {
    return null;
  } finally {
    if (temp) {
      try {
        fs.unlinkSync(temp);
      } catch {
        /* a temp we could not clean is swept elsewhere */
      }
    }
  }
}

export function offloadChatImage(image: ChatImage, userData: string): ChatImage {
  // No store, no offload. Without this a caller with no user-data directory
  // writes an "attachments" folder into whatever the working directory happens
  // to be, and then clears the inline copy on the strength of it.
  if (!userData.trim()) return image;
  const derived = image.derivedImages?.map((row) => offloadChatImage(row, userData));
  const next: ChatImage = derived ? { ...image, derivedImages: derived } : { ...image };
  const raw = typeof next.data === "string" ? stripDataUrl(next.data) : "";
  if (raw) {
    // Buffer.from does not throw on malformed base64 — it drops what it cannot
    // read and returns the rest. Offloading that would store a corrupted blob
    // and then clear the only good copy, so anything questionable stays inline.
    if (!BASE64_ONLY.test(raw)) return next;
    const bytes = Buffer.from(raw, "base64");
    if (!bytes.length) return next;
    const dest = writeHashedBlob(userData, bytes, extFor(next));
    if (!dest) return next;
    return { ...next, data: "", sourcePath: dest, size: next.size ?? bytes.length };
  }
  const source = next.sourcePath?.trim();
  if (!source) return next;
  if (insideDir(attachmentsDir(userData), source)) return next;
  try {
    const bytes = fs.readFileSync(source);
    if (!bytes.length) return next;
    const dest = writeHashedBlob(userData, bytes, extFor(next, source));
    if (!dest) return next;
    return { ...next, data: "", sourcePath: dest, size: next.size ?? bytes.length };
  } catch {
    return next;
  }
}

function mapSessionImages(session: Record<string, unknown>, userData: string): Record<string, unknown> {
  const messages = Array.isArray(session.messages)
    ? session.messages.map((message) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) return message;
        const row = message as Record<string, unknown>;
        if (!Array.isArray(row.images)) return row;
        return {
          ...row,
          images: row.images.map((image) =>
            image && typeof image === "object" ? offloadChatImage(image as ChatImage, userData) : image,
          ),
        };
      })
    : session.messages;
  const composerImages = Array.isArray(session.composerImages)
    ? session.composerImages.map((image) =>
        image && typeof image === "object" ? offloadChatImage(image as ChatImage, userData) : image,
      )
    : session.composerImages;
  return { ...session, messages, composerImages };
}

/** Move inlined attachment bytes into userData/attachments. Fail closed: keep data if the write fails. */
export function offloadStateAttachments<T>(state: T, userData: string): T {
  if (!state || typeof state !== "object") return state;
  const next = structuredClone(state) as T & { sessions?: unknown };
  if (!Array.isArray(next.sessions) || !userData.trim()) return next;
  next.sessions = next.sessions.map((session) =>
    session && typeof session === "object" && !Array.isArray(session)
      ? mapSessionImages(session as Record<string, unknown>, userData)
      : session,
  );
  return next;
}

/**
 * Put the bytes back for a turn that is about to be sent.
 *
 * A miss throws. It used to return the picture with empty data, and the vendor
 * path turns that into the words "Attached image …" — so the turn succeeded,
 * the person was billed for it, and the model never saw the picture. A turn
 * that fails is recoverable; one that quietly answers about nothing is not.
 */
export function hydrateChatImage(image: ChatImage): ChatImage {
  const derived = image.derivedImages?.map(hydrateChatImage);
  const next: ChatImage = derived ? { ...image, derivedImages: derived } : { ...image };
  const raw = typeof next.data === "string" ? stripDataUrl(next.data) : "";
  if (raw) return raw === next.data ? next : { ...next, data: raw };
  const source = next.sourcePath?.trim();
  if (!source) return next;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(source);
  } catch {
    throw new Error(`Attachment is missing from disk: ${next.name || source}`);
  }
  if (!bytes.length) throw new Error(`Attachment is empty on disk: ${next.name || source}`);
  // Our own blobs are named for their content, so a short or swapped file is
  // catchable here rather than being sent as a corrupt image.
  const named = path.basename(source).split(".")[0];
  if (/^[0-9a-f]{64}$/.test(named)) {
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== named) throw new Error(`Attachment does not match its checksum: ${next.name || source}`);
  }
  return { ...next, data: bytes.toString("base64"), size: bytes.length };
}

export function hydrateChatImages(images: ChatImage[] | undefined): ChatImage[] {
  return (images ?? []).map(hydrateChatImage);
}

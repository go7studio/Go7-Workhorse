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

function writeHashedBlob(userData: string, bytes: Buffer, ext: string): string | null {
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const dir = attachmentsDir(userData);
  const dest = path.join(dir, `${hash}.${ext}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(dest)) {
      const temp = `${dest}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temp, bytes);
      try {
        fs.renameSync(temp, dest);
      } catch {
        try {
          fs.writeFileSync(dest, bytes);
        } finally {
          try {
            fs.unlinkSync(temp);
          } catch {
            /* leftover temp */
          }
        }
      }
    }
    return dest;
  } catch {
    return null;
  }
}

export function offloadChatImage(image: ChatImage, userData: string): ChatImage {
  const derived = image.derivedImages?.map((row) => offloadChatImage(row, userData));
  const next: ChatImage = derived ? { ...image, derivedImages: derived } : { ...image };
  const raw = typeof next.data === "string" ? stripDataUrl(next.data) : "";
  if (raw) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(raw, "base64");
    } catch {
      return next;
    }
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

export function hydrateChatImage(image: ChatImage): ChatImage {
  const derived = image.derivedImages?.map(hydrateChatImage);
  const next: ChatImage = derived ? { ...image, derivedImages: derived } : { ...image };
  const raw = typeof next.data === "string" ? stripDataUrl(next.data) : "";
  if (raw) return raw === next.data ? next : { ...next, data: raw };
  const source = next.sourcePath?.trim();
  if (!source) return next;
  try {
    const bytes = fs.readFileSync(source);
    if (!bytes.length) return next;
    return { ...next, data: bytes.toString("base64"), size: next.size ?? bytes.length };
  } catch {
    return next;
  }
}

export function hydrateChatImages(images: ChatImage[] | undefined): ChatImage[] {
  return (images ?? []).map(hydrateChatImage);
}

import { uid } from "./id";
import { pathToMediaUrl } from "./media-display";
import type { AttachmentKind, ChatImage } from "./types";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
export const MAX_IMAGES = 24;
export const MAX_MODEL_IMAGE_PAYLOAD_BYTES = 5 * 1024 * 1024;

const SKIP_DROP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "coverage",
  ".next",
  "out",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "vendor",
]);

export function shouldSkipDropDir(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (SKIP_DROP_DIRS.has(trimmed)) return true;
  return trimmed.startsWith(".") && trimmed !== ".";
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};

const ALLOWED = new Set(Object.values(MIME_BY_EXT));

const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
};

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/opus",
  webm: "audio/webm",
};

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

/**
 * A text file's real type, for the paths where nobody hands us one. A drop from
 * Finder carries File.type; a CLI attachment is just a path, and answering
 * text/plain for every one of them loses html and markdown for no reason.
 * Anything absent here is still text — it just falls back to text/plain.
 */
const TEXT_MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonc: "application/json",
  xml: "application/xml",
  svg: "image/svg+xml",
  yml: "application/yaml",
  yaml: "application/yaml",
};

const TEXT_EXT = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "csv",
  "tsv",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "svg",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "rb",
  "php",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "yml",
  "yaml",
  "toml",
  "ini",
  "env",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "rhai",
  "lua",
  "log",
  "diff",
  "patch",
  "gitignore",
  "dockerignore",
  "editorconfig",
  "lock",
]);

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export function imageMime(file: { name?: string; type?: string }): string | null {
  const type = (file.type ?? "").toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  if (ALLOWED.has(type)) return type;
  const ext = file.name?.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? null;
}

function mappedMime(file: { name?: string; type?: string }, family: "document" | "audio" | "video"): string | null {
  const type = (file.type ?? "").toLowerCase();
  const ext = file.name?.split(".").pop()?.toLowerCase() ?? "";
  const map = family === "document" ? DOCUMENT_MIME_BY_EXT : family === "audio" ? AUDIO_MIME_BY_EXT : VIDEO_MIME_BY_EXT;
  if (type && (family === "document" ? Object.values(map).includes(type) : type.startsWith(`${family}/`))) return type;
  return map[ext] ?? null;
}

export function attachmentKind(file: { name?: string; type?: string }): AttachmentKind | null {
  if (imageMime(file)) return "image";
  if (isTextFile(file)) return "file";
  if (mappedMime(file, "document")) return "document";
  if (mappedMime(file, "audio")) return "audio";
  if (mappedMime(file, "video")) return "video";
  return null;
}

export function attachmentMime(file: { name?: string; type?: string }, kind = attachmentKind(file)): string {
  if (kind === "image") return imageMime(file) ?? "image/png";
  if (kind === "document" || kind === "audio" || kind === "video") return mappedMime(file, kind) ?? file.type ?? "application/octet-stream";
  const ext = file.name?.toLowerCase().split(".").pop() ?? "";
  return file.type || TEXT_MIME_BY_EXT[ext] || "text/plain";
}

export function isPicture(item: Pick<ChatImage, "kind" | "mimeType" | "name">): boolean {
  return item.kind !== "file" && Boolean(imageMime({ type: item.mimeType, name: item.name }));
}

export function isTextFile(file: { name?: string; type?: string }): boolean {
  if (imageMime(file)) return false;
  const type = (file.type ?? "").toLowerCase();
  if (type.startsWith("text/")) return true;
  if (
    type === "application/json" ||
    type === "application/javascript" ||
    type === "application/typescript" ||
    type.includes("xml") ||
    type.includes("yaml")
  ) {
    return true;
  }
  const name = file.name?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.split(".").pop() ?? "" : "";
  return ext ? TEXT_EXT.has(ext) : false;
}

export function imageSrc(image: Pick<ChatImage, "mimeType" | "data" | "sourcePath">): string {
  const sourcePath = image.sourcePath?.trim();
  if (sourcePath) return pathToMediaUrl(sourcePath);
  return `data:${image.mimeType};base64,${image.data}`;
}

/** Bytes already on the attachment, never a media-protocol URL that taints a canvas. */
export function imageSrcForModel(image: Pick<ChatImage, "mimeType" | "data" | "sourcePath">): string {
  if (image.data) return `data:${image.mimeType};base64,${image.data}`;
  return imageSrc(image);
}

export function base64DecodedBytes(data: string): number {
  const value = data.replace(/^data:[^;]+;base64,/, "");
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

export function modelImagePayloadBytes(images: ChatImage[]): number {
  return images.reduce((total, image) => {
    if (image.kind === "image") return total + base64DecodedBytes(image.data);
    return total + modelImagePayloadBytes(image.derivedImages ?? []);
  }, 0);
}

function loadImage(image: ChatImage): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error(`Could not resize ${image.name}`));
    element.src = imageSrcForModel(image);
  });
}

async function resizeModelImage(image: ChatImage, maxEdge: number, quality: number): Promise<ChatImage> {
  if (image.kind !== "image" || !image.data) return image;
  const element = await loadImage(image);
  const ratio = Math.min(1, maxEdge / Math.max(element.naturalWidth, element.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(element.naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(element.naturalHeight * ratio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error(`Could not resize ${image.name}`);
  context.drawImage(element, 0, 0, canvas.width, canvas.height);
  const encoded = canvas.toDataURL("image/jpeg", quality);
  const data = encoded.slice(encoded.indexOf(",") + 1);
  const name = image.name.replace(/\.[^.]+$/, "") || "image";
  return {
    ...image,
    name: `${name}.jpg`,
    mimeType: "image/jpeg",
    data,
    size: base64DecodedBytes(data),
  };
}

export async function fitModelImages(
  attachments: ChatImage[],
  maxBytes = MAX_MODEL_IMAGE_PAYLOAD_BYTES,
): Promise<ChatImage[]> {
  if (modelImagePayloadBytes(attachments) <= maxBytes) return attachments;
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("Images are too large. Split them into smaller calls.");
  }
  let fitted = attachments;
  for (const [maxEdge, quality] of [[1600, 0.78], [1280, 0.68], [960, 0.58]] as const) {
    fitted = await Promise.all(fitted.map((image) => resizeModelImage(image, maxEdge, quality)));
    if (modelImagePayloadBytes(fitted) <= maxBytes) return fitted;
  }
  throw new Error("Images are too large. Split them into smaller calls.");
}

function looksLikeText(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 4000);
  let bad = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 0) return false;
    if (code < 9 || (code > 13 && code < 32)) bad += 1;
  }
  return bad / sample.length < 0.05;
}

export function normalizeImages(raw: unknown): ChatImage[] {
  if (!Array.isArray(raw)) return [];
  const images: ChatImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<ChatImage>;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "file";
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
    const text = typeof record.text === "string" ? record.text : "";
    const kind = record.kind ?? attachmentKind({ type: mimeType, name });
    if (kind === "file" || (text && kind !== "image")) {
      if (!text) continue;
      images.push({
        id: typeof record.id === "string" && record.id ? record.id : uid("file"),
        name,
        mimeType: mimeType || "text/plain",
        data: "",
        kind: "file",
        text,
        ...(typeof record.folder === "string" && record.folder.trim() ? { folder: record.folder.trim() } : {}),
        ...(typeof record.sourcePath === "string" && record.sourcePath.trim() ? { sourcePath: record.sourcePath.trim() } : {}),
        ...(typeof record.size === "number" && record.size >= 0 ? { size: record.size } : {}),
      });
    } else if (kind === "image") {
      const imageType = imageMime({ type: mimeType, name: record.name });
      const data = typeof record.data === "string" ? record.data.replace(/^data:[^;]+;base64,/, "") : "";
      if (!imageType || !data) continue;
      images.push({
        id: typeof record.id === "string" && record.id ? record.id : uid("img"),
        name: name === "file" ? "image" : name,
        mimeType: imageType,
        data,
        kind: "image",
        ...(typeof record.folder === "string" && record.folder.trim() ? { folder: record.folder.trim() } : {}),
        ...(typeof record.sourcePath === "string" && record.sourcePath.trim() ? { sourcePath: record.sourcePath.trim() } : {}),
        ...(typeof record.size === "number" && record.size >= 0 ? { size: record.size } : {}),
      });
    } else if (kind === "document" || kind === "audio" || kind === "video") {
      const data = typeof record.data === "string" ? record.data.replace(/^data:[^;]+;base64,/, "") : "";
      const sourcePath = typeof record.sourcePath === "string" ? record.sourcePath.trim() : "";
      const derivedImages = record.derivedImages
        ? normalizeImages(record.derivedImages).filter((row) => row.kind === "image")
        : [];
      if (!data && !sourcePath && derivedImages.length === 0) continue;
      images.push({
        id: typeof record.id === "string" && record.id ? record.id : uid(kind),
        name,
        mimeType: mimeType || attachmentMime({ name }, kind),
        data,
        kind,
        ...(sourcePath ? { sourcePath } : {}),
        ...(typeof record.folder === "string" && record.folder.trim() ? { folder: record.folder.trim() } : {}),
        ...(typeof record.size === "number" && record.size >= 0 ? { size: record.size } : {}),
        ...(typeof record.durationMs === "number" && record.durationMs >= 0 ? { durationMs: record.durationMs } : {}),
        ...(derivedImages.length > 0 ? { derivedImages } : {}),
      });
    }
    if (images.length >= MAX_IMAGES) break;
  }
  return images;
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? "");
      const comma = raw.indexOf(",");
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

function mediaEvent(target: HTMLMediaElement, event: string, timeout = 4_000): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      window.clearTimeout(timer);
      target.removeEventListener(event, ready);
      target.removeEventListener("error", failed);
      resolve(value);
    };
    const ready = () => done(true);
    const failed = () => done(false);
    const timer = window.setTimeout(() => done(false), timeout);
    target.addEventListener(event, ready, { once: true });
    target.addEventListener("error", failed, { once: true });
  });
}

async function inspectMedia(file: File, kind: "audio" | "video"): Promise<{ durationMs?: number; frames?: ChatImage[] }> {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return {};
  const element = document.createElement(kind);
  element.preload = "metadata";
  element.muted = true;
  const href = URL.createObjectURL(file);
  element.src = href;
  try {
    if (!(await mediaEvent(element, "loadedmetadata"))) return {};
    const durationMs = Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : undefined;
    if (kind !== "video" || !(element instanceof HTMLVideoElement) || !element.videoWidth || !element.videoHeight) {
      return { durationMs };
    }
    const frames: ChatImage[] = [];
    const canvas = document.createElement("canvas");
    const ratio = Math.min(1, 1280 / element.videoWidth);
    canvas.width = Math.max(1, Math.round(element.videoWidth * ratio));
    canvas.height = Math.max(1, Math.round(element.videoHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) return { durationMs };
    const duration = Number.isFinite(element.duration) ? element.duration : 0;
    const samples = duration > 0 ? [0.1, 0.35, 0.65, 0.9] : [0];
    for (let index = 0; index < samples.length; index += 1) {
      element.currentTime = Math.max(0, Math.min(duration || 0, duration * samples[index]));
      if (!(await mediaEvent(element, "seeked", 2_500)) && index > 0) continue;
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const raw = canvas.toDataURL("image/jpeg", 0.78);
      const data = raw.slice(raw.indexOf(",") + 1);
      if (!data) continue;
      frames.push({
        id: uid("frame"),
        name: `${file.name || "video"} · frame ${index + 1}`,
        mimeType: "image/jpeg",
        data,
        kind: "image",
      });
    }
    return { durationMs, frames };
  } finally {
    element.removeAttribute("src");
    URL.revokeObjectURL(href);
  }
}

export async function readChatAttachment(file: File, sourcePath?: string): Promise<ChatImage | null> {
  if (file.size <= 0) return null;
  const kind = attachmentKind(file);
  const mimeType = attachmentMime(file, kind);
  const path = sourcePath?.trim() || "";
  if (kind === "image") {
    if (file.size > MAX_IMAGE_BYTES) return null;
    const data = await fileToBase64(file);
    if (!data) return null;
    return {
      id: uid("img"),
      name: file.name?.trim() || "image",
      mimeType,
      data,
      kind: "image",
      size: file.size,
      ...(path ? { sourcePath: path } : {}),
    };
  }
  if (kind === "document" || kind === "audio" || kind === "video") {
    const limit = kind === "document" ? MAX_DOCUMENT_BYTES : kind === "audio" ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES;
    if (file.size > limit) return null;
    const media = kind === "audio" || kind === "video" ? await inspectMedia(file, kind) : {};
    const data = kind === "video" ? "" : await fileToBase64(file);
    if (!data && !path && !media.frames?.length) return null;
    return {
      id: uid(kind),
      name: file.name?.trim() || kind,
      mimeType,
      data,
      kind,
      size: file.size,
      ...(path ? { sourcePath: path } : {}),
      ...(media.durationMs !== undefined ? { durationMs: media.durationMs } : {}),
      ...(media.frames?.length ? { derivedImages: media.frames } : {}),
    };
  }
  if (kind !== "file") return null;
  if (file.size > MAX_FILE_BYTES) return null;
  if (!isTextFile(file) && file.size > 32 * 1024) return null;
  const text = await file.text();
  if (!looksLikeText(text)) return null;
  return {
    id: uid("file"),
    name: file.name?.trim() || "file",
    mimeType: file.type || "text/plain",
    data: "",
    kind: "file",
    text,
    size: file.size,
    ...(path ? { sourcePath: path } : {}),
  };
}

type DropEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (ok: (file: File) => void, err?: (error: Error) => void) => void;
  createReader: () => {
    readEntries: (ok: (entries: DropEntry[]) => void, err?: (error: Error) => void) => void;
  };
};

function entryFromItem(item: DataTransferItem): DropEntry | null {
  const record = item as unknown as {
    webkitGetAsEntry?: () => DropEntry | null;
    getAsEntry?: () => DropEntry | null;
  };
  return record.webkitGetAsEntry?.() ?? record.getAsEntry?.() ?? null;
}

function entriesFromDataTransfer(transfer: DataTransfer): DropEntry[] {
  const entries: DropEntry[] = [];
  for (const item of transfer.items) {
    if (item.kind !== "file") continue;
    const entry = entryFromItem(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function readDirectory(reader: ReturnType<DropEntry["createReader"]>): Promise<DropEntry[]> {
  const rows: DropEntry[] = [];
  for (;;) {
    const batch = await new Promise<DropEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    rows.push(...batch);
  }
  return rows;
}

function fileWithName(file: File, name: string): File {
  if (file.name === name) return file;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

export type DroppedFile = {
  file?: File;
  attachment?: ChatImage;
  folder?: string;
  sourcePath?: string;
};

export type AttachmentGroup =
  | { type: "folder"; name: string; files: ChatImage[] }
  | { type: "file"; file: ChatImage };

export function folderNameFromPath(name: string): string | undefined {
  const parts = name.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : undefined;
}

/** File picker and folder picker both land here. Folder picks carry webkitRelativePath. */
export function droppedFromPickerFile(file: File, sourcePath?: string): DroppedFile {
  const relative = typeof file.webkitRelativePath === "string" ? file.webkitRelativePath : "";
  return {
    file,
    sourcePath,
    folder: folderNameFromPath(relative || file.name),
  };
}

/** Disk paths from the Attach dialog. A folder root is walked and grouped. */
export async function droppedFromDiskPaths(paths: string[]): Promise<DroppedFile[]> {
  const clean = paths.map((item) => item.trim()).filter(Boolean);
  if (clean.length === 0 || !window.workhorse?.listDropFiles) return [];
  return filesFromListedDrop(await window.workhorse.listDropFiles(clean));
}

export function groupAttachments(items: ChatImage[]): AttachmentGroup[] {
  const folders = new Map<string, ChatImage[]>();
  const loose: ChatImage[] = [];
  for (const item of items) {
    const folder = item.folder?.trim() || folderNameFromPath(item.name);
    if (folder) {
      const list = folders.get(folder) ?? [];
      list.push(item);
      folders.set(folder, list);
      continue;
    }
    loose.push(item);
  }
  return [
    ...[...folders.entries()].map(([name, files]) => ({ type: "folder" as const, name, files })),
    ...loose.map((file) => ({ type: "file" as const, file })),
  ];
}

async function collectDropEntry(entry: DropEntry, prefix: string, folder: string | undefined, into: DroppedFile[]): Promise<void> {
  if (into.length >= MAX_IMAGES) return;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file(resolve, reject);
    });
    into.push({
      file: fileWithName(file, prefix ? `${prefix}/${file.name}` : file.name),
      ...(folder ? { folder } : {}),
      ...(window.workhorse?.pathForFile(file) ? { sourcePath: window.workhorse.pathForFile(file) } : {}),
    });
    return;
  }
  if (!entry.isDirectory || shouldSkipDropDir(entry.name)) return;
  const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
  const nextFolder = folder ?? entry.name;
  const children = await readDirectory(entry.createReader());
  for (const child of children) {
    if (into.length >= MAX_IMAGES) return;
    await collectDropEntry(child, nextPrefix, nextFolder, into);
  }
}

export function filesFromDataTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return [...transfer.files];
}

function filesFromListedDrop(
  rows: {
    name: string;
    mimeType: string;
    kind: AttachmentKind;
    text?: string;
    data?: string;
    sourcePath?: string;
    size?: number;
  }[],
): DroppedFile[] {
  const files: DroppedFile[] = [];
  for (const row of rows) {
    const folder = folderNameFromPath(row.name);
    let file: File | null = null;
    if (row.kind === "image" && row.data) {
      const binary = atob(row.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      file = new File([bytes], row.name, { type: row.mimeType });
    } else if (row.text) {
      file = new File([row.text], row.name, { type: row.mimeType || "text/plain" });
    }
    if (file) files.push({ file, ...(folder ? { folder } : {}), ...(row.sourcePath ? { sourcePath: row.sourcePath } : {}) });
    else if (row.sourcePath) {
      files.push({
        attachment: {
          id: uid(row.kind),
          name: row.name,
          mimeType: row.mimeType,
          data: row.data ?? "",
          kind: row.kind,
          sourcePath: row.sourcePath,
          size: row.size,
        },
        ...(folder ? { folder } : {}),
        sourcePath: row.sourcePath,
      });
    }
  }
  return files;
}

export async function collectDroppedFiles(transfer: DataTransfer | null): Promise<DroppedFile[]> {
  if (!transfer) return [];
  const entries = entriesFromDataTransfer(transfer);
  if (entries.length > 0) {
    const collected: DroppedFile[] = [];
    for (const entry of entries) {
      if (collected.length >= MAX_IMAGES) break;
      await collectDropEntry(entry, "", entry.isDirectory ? entry.name : undefined, collected);
    }
    if (collected.some((item) => (item.file?.size ?? 0) > 0 || item.attachment)) return collected;
  }
  const listed = filesFromDataTransfer(transfer);
  const disk = window.workhorse?.listDropFiles
    ? listed.map((file) => window.workhorse?.pathForFile(file) ?? "").filter(Boolean)
    : [];
  if (disk.length > 0 && window.workhorse?.listDropFiles) {
    const rows = await window.workhorse.listDropFiles(disk);
    const files = filesFromListedDrop(rows);
    if (files.length > 0) return files;
  }
  return listed.map((file) => ({ file, ...(window.workhorse?.pathForFile(file) ? { sourcePath: window.workhorse.pathForFile(file) } : {}) }));
}

export function dataTransferLooksLikeFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  if (transfer.files.length > 0) return true;
  const types = [...transfer.types];
  if (types.includes("Files") || types.includes("public.file-url")) return true;
  return [...transfer.items].some((item) => item.kind === "file");
}

export function filesFromClipboard(clipboard: DataTransfer | null): File[] {
  if (!clipboard) return [];
  const fromItems = [...clipboard.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  return fromItems.length > 0 ? fromItems : filesFromDataTransfer(clipboard);
}

export function filePromptBlock(file: ChatImage): string {
  const body = file.text ?? "";
  return `Attached file \`${file.name}\`:\n\n\`\`\`\n${body}\n\`\`\``;
}

function mediaLength(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) return "";
  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

export function attachmentLabel(file: ChatImage): string {
  const kind = file.kind === "document" ? "Document" : file.kind === "audio" ? "Audio" : file.kind === "video" ? "Video" : "File";
  const length = mediaLength(file.durationMs);
  return length ? `${kind} · ${length}` : kind;
}

export function attachmentPromptBlock(file: ChatImage): string {
  if (file.kind === "file" || file.text) return filePromptBlock(file);
  const kind = file.kind ?? "attachment";
  const details = [file.mimeType, mediaLength(file.durationMs), file.size ? `${Math.ceil(file.size / 1024)} KB` : ""]
    .filter(Boolean)
    .join(" · ");
  const source = file.sourcePath ? `\nSource: \`${file.sourcePath}\`` : "";
  const frames = file.derivedImages?.length ? `\n${file.derivedImages.length} representative frames follow.` : "";
  return `Attached ${kind} \`${file.name}\`${details ? ` (${details})` : ""}.${source}${frames}`;
}

export function buildAcpPrompt(text: string, images: ChatImage[] = []): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  for (const image of images) {
    if (image.kind === "file" || (image.text && !isPicture(image))) {
      if (image.text) blocks.push({ type: "text", text: filePromptBlock(image) });
      continue;
    }
    if (isPicture(image) && image.data && image.mimeType) {
      blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
      continue;
    }
    blocks.push({ type: "text", text: attachmentPromptBlock(image) });
    for (const frame of image.derivedImages ?? []) {
      if (frame.data && frame.mimeType) blocks.push({ type: "image", mimeType: frame.mimeType, data: frame.data });
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return blocks;
}

export function hasSendableAttachment(image: ChatImage): boolean {
  if (image.kind === "file" || image.text) return Boolean(image.text);
  return Boolean((image.data && image.mimeType) || image.sourcePath || image.derivedImages?.length);
}

import { uid } from "./id";
import type { ChatImage } from "./types";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_IMAGES = 24;

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

export function isAttachmentFile(file: { name?: string; type?: string }): boolean {
  return Boolean(imageMime(file) || isTextFile(file));
}

export function imageSrc(image: Pick<ChatImage, "mimeType" | "data">): string {
  return `data:${image.mimeType};base64,${image.data}`;
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
    if (record.kind === "file" || (text && !imageMime({ type: mimeType, name }))) {
      if (!text) continue;
      images.push({
        id: typeof record.id === "string" && record.id ? record.id : uid("file"),
        name,
        mimeType: mimeType || "text/plain",
        data: "",
        kind: "file",
        text,
        ...(typeof record.folder === "string" && record.folder.trim() ? { folder: record.folder.trim() } : {}),
      });
    } else {
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

export async function readChatImage(file: File): Promise<ChatImage | null> {
  return readChatAttachment(file);
}

export async function readChatAttachment(file: File): Promise<ChatImage | null> {
  if (file.size <= 0) return null;
  const mimeType = imageMime(file);
  if (mimeType) {
    if (file.size > MAX_IMAGE_BYTES) return null;
    const data = await fileToBase64(file);
    if (!data) return null;
    return {
      id: uid("img"),
      name: file.name?.trim() || "image",
      mimeType,
      data,
      kind: "image",
    };
  }
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
  file: File;
  folder?: string;
};

export type AttachmentGroup =
  | { type: "folder"; name: string; files: ChatImage[] }
  | { type: "file"; file: ChatImage };

export function folderNameFromPath(name: string): string | undefined {
  const parts = name.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : undefined;
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
    kind: "image" | "file";
    text?: string;
    data?: string;
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
    if (file) files.push({ file, ...(folder ? { folder } : {}) });
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
    if (collected.some((item) => item.file.size > 0)) return collected;
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
  return listed.map((file) => ({ file }));
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

export function buildAcpPrompt(text: string, images: ChatImage[] = []): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  for (const image of images) {
    if (image.kind === "file" || (image.text && !isPicture(image))) {
      if (image.text) blocks.push({ type: "text", text: filePromptBlock(image) });
      continue;
    }
    if (image.data && image.mimeType) {
      blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return blocks;
}

export function hasSendableAttachment(image: ChatImage): boolean {
  if (image.kind === "file" || image.text) return Boolean(image.text);
  return Boolean(image.data && image.mimeType);
}

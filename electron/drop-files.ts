import fs from "node:fs";
import path from "node:path";
import {
  imageMime,
  attachmentKind,
  attachmentMime,
  isTextFile,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_AUDIO_BYTES,
  MAX_VIDEO_BYTES,
  MAX_IMAGES,
  shouldSkipDropDir,
} from "../src/lib/images";

export type ListedDropFile = {
  name: string;
  mimeType: string;
  kind: import("../src/lib/types").AttachmentKind;
  text?: string;
  data?: string;
  sourcePath?: string;
  size?: number;
};

function walkDropPath(abs: string, rel: string, into: { name: string; path: string }[]): void {
  if (into.length >= MAX_IMAGES) return;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return;
  }
  if (stat.isFile()) {
    into.push({ name: rel || path.basename(abs), path: abs });
    return;
  }
  if (!stat.isDirectory()) return;
  let names: string[] = [];
  try {
    names = fs.readdirSync(abs);
  } catch {
    return;
  }
  for (const name of names) {
    if (shouldSkipDropDir(name)) continue;
    walkDropPath(path.join(abs, name), rel ? `${rel}/${name}` : name, into);
  }
}

export function listDropFiles(roots: unknown): ListedDropFile[] {
  const start = (Array.isArray(roots) ? roots : []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const paths: { name: string; path: string }[] = [];
  for (const root of start) {
    const resolved = path.resolve(root);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkDropPath(resolved, path.basename(resolved), paths);
    else if (stat.isFile()) paths.push({ name: path.basename(resolved), path: resolved });
  }
  const files: ListedDropFile[] = [];
  for (const item of paths) {
    if (files.length >= MAX_IMAGES) break;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(item.path);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    const imageType = imageMime({ name: item.name });
    if (imageType) {
      if (stat.size > MAX_IMAGE_BYTES) continue;
      files.push({
        name: item.name,
        mimeType: imageType,
        kind: "image",
        data: fs.readFileSync(item.path).toString("base64"),
      });
      continue;
    }
    if (isTextFile({ name: item.name })) {
      if (stat.size > MAX_FILE_BYTES) continue;
      files.push({
        name: item.name,
        mimeType: "text/plain",
        kind: "file",
        text: fs.readFileSync(item.path, "utf8"),
        sourcePath: item.path,
        size: stat.size,
      });
      continue;
    }
    const kind = attachmentKind({ name: item.name });
    const limit = kind === "document" ? MAX_DOCUMENT_BYTES : kind === "audio" ? MAX_AUDIO_BYTES : kind === "video" ? MAX_VIDEO_BYTES : 0;
    if (!kind || !limit || stat.size > limit) continue;
    files.push({
      name: item.name,
      mimeType: attachmentMime({ name: item.name }, kind),
      kind,
      sourcePath: item.path,
      size: stat.size,
    });
  }
  return files;
}

/**
 * Workshop pack install: archive from a public GitHub tag, or a copied folder. See workshop/PACKS.md §5.
 *
 * No version-control binary, no child process, no extraction library. Everything a pack ships lands in a private
 * staging directory first — files only, no links, capped in count and bytes — then `pack.json` is
 * validated against the host contract and the folder is renamed into `<root>/<id>/` atomically.
 * Nothing from a pack is executed, imported, or chmodded.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  PACK_ID,
  PACK_LIMITS,
  highestSemverTag,
  parseWorkshopPack,
  type InstallResult,
  type PackSource,
  type WorkshopPack,
} from "../src/lib/workshop-pack";

export const INSTALL_RECORD = ".install.json";
const PACK_MANIFEST = "pack.json";
const FETCH_TIMEOUT_MS = 30_000;
const TAGS_BODY_BYTES = 1024 * 1024;
/** gunzip output ceiling: the content cap plus generous room for tar headers and padding. */
const TAR_OUTPUT_BYTES = PACK_LIMITS.maxInstallBytes * 2 + 4 * 1024 * 1024;
const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "Go7-Workhorse" };
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export type InstallRecord = { kind: "folder" | "repo"; from: string; tag?: string; sha256: string; at: string };
export type UpdateCheck = { ok: boolean; current: string; latest?: string; reason?: string };
export type UpdateResult = InstallResult & { sourcesChanged?: boolean };
export type TarEntry = { path: string; type: "file" | "dir"; data: Buffer };

class Refusal extends Error {}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------------------------
// Paths

/** Segments a pack may ship: nothing that escapes, nothing Windows cannot hold. */
export function checkRelativePath(rel: string): string | null {
  if (rel.includes("\0")) return "NUL in path";
  if (rel.includes("\\")) return "backslash in path";
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return "absolute path";
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return "path escapes the pack";
    if (/[\u0000-\u001f]/.test(seg)) return "control character in path";
    if (WINDOWS_RESERVED.test(seg) || /[. ]$/.test(seg)) return `Windows-unsafe name ${JSON.stringify(seg)}`;
  }
  return null;
}

function safeJoin(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(base)) return null;
  return resolved;
}

/** An installed folder whose name case-folds to `id` but is not `id` — a collision on case-insensitive disks. */
export function findCaseCollision(existingNames: string[], id: string): string | null {
  const folded = id.toLowerCase();
  return existingNames.find((name) => name !== id && name.toLowerCase() === folded) ?? null;
}

export function readInstallRecord(packDir: string): InstallRecord | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(packDir, INSTALL_RECORD), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return undefined;
    if ((raw.kind !== "folder" && raw.kind !== "repo") || typeof raw.from !== "string") return undefined;
    if (typeof raw.sha256 !== "string" || typeof raw.at !== "string") return undefined;
    return {
      kind: raw.kind,
      from: raw.from,
      sha256: raw.sha256,
      at: raw.at,
      ...(typeof raw.tag === "string" ? { tag: raw.tag } : {}),
    };
  } catch {
    return undefined;
  }
}

function readPackJson(packDir: string): { raw: unknown; bytes: Buffer } | null {
  try {
    const bytes = fs.readFileSync(path.join(packDir, PACK_MANIFEST));
    return { raw: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub

export function parseGitHubRepoUrl(input: string): { owner: string; repo: string; canonical: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m) return null;
  const [, owner, repo] = m;
  const NAME = /^[A-Za-z0-9_.-]+$/;
  if (!NAME.test(owner) || !NAME.test(repo) || owner.includes("..") || repo.includes("..")) return null;
  if (owner === "." || repo === ".") return null;
  return { owner, repo, canonical: `https://github.com/${owner}/${repo}` };
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Read at most `cap` bytes; anything past it is a refusal, not a truncation. */
export async function readBytesCapped(response: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.byteLength > cap ? null : bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function fetchTags(owner: string, repo: string, fetchImpl: typeof fetch): Promise<string[]> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `https://api.github.com/repos/${owner}/${repo}/tags?per_page=100`,
      { method: "GET", headers: GITHUB_HEADERS, redirect: "error" },
      FETCH_TIMEOUT_MS,
    );
  } catch {
    refuse("GitHub unreachable");
  }
  if (response.status === 404) refuse("repository not found");
  if (response.status !== 200) refuse(`tags: http-${response.status}`);
  const body = await readBytesCapped(response, TAGS_BODY_BYTES);
  if (!body) refuse("tags: response too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    refuse("tags: malformed response");
  }
  if (!Array.isArray(parsed)) refuse("tags: malformed response");
  return parsed
    .map((item) => (item && typeof item === "object" ? (item as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === "string");
}

async function fetchTarball(owner: string, repo: string, tag: string, fetchImpl: typeof fetch): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/tags/${encodeURIComponent(tag)}`,
      { method: "GET", headers: { "User-Agent": "Go7-Workhorse", Accept: "application/octet-stream" }, redirect: "follow" },
      FETCH_TIMEOUT_MS,
    );
  } catch {
    refuse("archive download failed");
  }
  if (response.status !== 200) refuse(`archive: http-${response.status}`);
  const bytes = await readBytesCapped(response, PACK_LIMITS.maxInstallBytes);
  if (!bytes) refuse(`archive over ${PACK_LIMITS.maxInstallBytes / (1024 * 1024)} MiB`);
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// ustar reader (files and directories only; GNU long names and pax paths honoured; links refused)

function cstr(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString("utf8");
}

function octal(buf: Buffer, start: number, len: number): number {
  if (buf[start] & 0x80) refuse("archive: base-256 size field");
  const text = cstr(buf, start, len).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) refuse("archive: bad numeric field");
  return parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = cstr(header, 148, 8).trim();
  if (!/^[0-7]+$/.test(stored)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum === parseInt(stored, 8);
}

function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  let found: string | undefined;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const len = Number(data.subarray(offset, space).toString("utf8"));
    if (!Number.isInteger(len) || len <= 0 || offset + len > data.length) refuse("archive: bad pax record");
    const record = data.subarray(space + 1, offset + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") found = record.slice(eq + 1);
    offset += len;
  }
  return found;
}

/**
 * Parse a tar stream into file and directory entries with the first path component (GitHub's
 * `repo-tag/`) removed. Throws on links, device nodes, escapes, and anything over the install caps.
 */
export function readTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let paxName: string | undefined;
  let files = 0;
  let bytes = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    if (!checksumOk(header)) refuse("archive: bad header checksum");
    const size = octal(header, 124, 12);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    if (dataStart + size > tar.length) refuse("archive: truncated");
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      paxName = paxPath(data);
      continue;
    }
    if (type === "g") continue;

    const prefix = cstr(header, 345, 155);
    const shortName = cstr(header, 0, 100);
    const rawName = paxName ?? longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    longName = undefined;
    paxName = undefined;

    if (type === "1" || type === "2") refuse(`archive contains a link: ${rawName}`);
    if (type !== "0" && type !== "5") refuse(`archive: unsupported entry type ${JSON.stringify(type)} at ${rawName}`);
    const problem = checkRelativePath(rawName);
    if (problem) refuse(`archive: ${problem} (${rawName})`);
    const parts = rawName.split("/").filter((seg) => seg !== "" && seg !== ".");
    if (parts.length <= 1) continue; // the top-level folder itself
    const rel = parts.slice(1).join("/");
    if (parts[parts.length - 1] === INSTALL_RECORD) continue;
    if (type === "5") {
      entries.push({ path: rel, type: "dir", data: Buffer.alloc(0) });
      continue;
    }
    files += 1;
    bytes += size;
    if (files > PACK_LIMITS.maxFiles) refuse(`archive has more than ${PACK_LIMITS.maxFiles} files`);
    if (bytes > PACK_LIMITS.maxInstallBytes) refuse(`archive unpacks past ${PACK_LIMITS.maxInstallBytes / (1024 * 1024)} MiB`);
    entries.push({ path: rel, type: "file", data: Buffer.from(data) });
  }
  return entries;
}

function writeEntries(entries: TarEntry[], staging: string): void {
  for (const entry of entries) {
    const target = safeJoin(staging, entry.path);
    if (!target || target === path.resolve(staging)) refuse(`archive: path escapes the pack (${entry.path})`);
    if (entry.type === "dir") {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data, { flag: "wx" });
  }
}

// ---------------------------------------------------------------------------------------------
// Folder copy

function copyTree(src: string, staging: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const from = path.join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      const problem = checkRelativePath(relPath);
      if (problem) refuse(`${problem} (${relPath})`);
      const stat = fs.lstatSync(from);
      if (stat.isSymbolicLink()) refuse(`symlink refused: ${relPath}`);
      if (stat.isDirectory()) {
        fs.mkdirSync(path.join(staging, ...relPath.split("/")), { recursive: true });
        walk(from, relPath);
        continue;
      }
      if (!stat.isFile()) refuse(`special file refused: ${relPath}`);
      if (stat.nlink > 1) refuse(`hard link refused: ${relPath}`);
      if (entry === INSTALL_RECORD) continue;
      files += 1;
      bytes += stat.size;
      if (files > PACK_LIMITS.maxFiles) refuse(`folder has more than ${PACK_LIMITS.maxFiles} files`);
      if (bytes > PACK_LIMITS.maxInstallBytes) refuse(`folder is over ${PACK_LIMITS.maxInstallBytes / (1024 * 1024)} MiB`);
      const to = path.join(staging, ...relPath.split("/"));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
  };
  walk(src, "");
}

// ---------------------------------------------------------------------------------------------
// Staging → validate → destination

type StagedPack = { dir: string; pack: WorkshopPack; manifestBytes: Buffer };

function makeStaging(root: string): string {
  const dir = path.join(root, "..", "staging", randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function subfoldersWithPack(dir: string): Array<{ dir: string; folderName: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, PACK_MANIFEST)))
    .map((entry) => ({ dir: path.join(dir, entry.name), folderName: entry.name }))
    .sort((a, b) => a.folderName.localeCompare(b.folderName));
}

function findPackFolders(staging: string): Array<{ dir: string; folderName?: string }> {
  if (fs.existsSync(path.join(staging, PACK_MANIFEST))) return [{ dir: staging }];
  const nested = subfoldersWithPack(path.join(staging, "packs"));
  if (nested.length) return nested;
  return subfoldersWithPack(staging);
}

function validateStaged(staging: string): StagedPack[] {
  const found = findPackFolders(staging);
  if (!found.length) refuse("no pack.json found (root, packs/*, or */)");
  const out: StagedPack[] = [];
  const ids = new Set<string>();
  for (const item of found) {
    const label = item.folderName ? `${item.folderName}: ` : "";
    const manifest = readPackJson(item.dir);
    if (!manifest) refuse(`${label}pack.json is not JSON`);
    const parsed = parseWorkshopPack(manifest.raw, item.folderName);
    if (!parsed.ok) refuse(`${label}${parsed.reason}`);
    if (ids.has(parsed.pack.id)) refuse(`duplicate pack id ${JSON.stringify(parsed.pack.id)}`);
    ids.add(parsed.pack.id);
    if (parsed.pack.collector) {
      const collector = safeJoin(item.dir, parsed.pack.collector);
      let isDir = false;
      try {
        isDir = Boolean(collector) && fs.lstatSync(collector as string).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) refuse(`${label}collector folder ${JSON.stringify(parsed.pack.collector)} is missing`);
    }
    out.push({ dir: item.dir, pack: parsed.pack, manifestBytes: manifest.bytes });
  }
  return out;
}

function replaceDir(from: string, to: string, tmpParent: string): void {
  const had = fs.existsSync(to);
  const tmp = path.join(tmpParent, `old-${randomBytes(6).toString("hex")}`);
  if (had) fs.renameSync(to, tmp);
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (had) {
      try {
        fs.renameSync(tmp, to);
      } catch {
        // the old folder stays under staging for the operator; nothing else to do
      }
    }
    throw error;
  }
  if (had) fs.rmSync(tmp, { recursive: true, force: true });
}

function commit(staging: string, root: string, record: (staged: StagedPack) => InstallRecord): InstallResult {
  const staged = validateStaged(staging);
  fs.mkdirSync(root, { recursive: true });
  const existing = fs.readdirSync(root);
  for (const item of staged) {
    const clash = findCaseCollision(existing, item.pack.id);
    if (clash) refuse(`id ${JSON.stringify(item.pack.id)} collides with installed folder ${JSON.stringify(clash)}`);
  }
  for (const item of staged) {
    fs.writeFileSync(path.join(item.dir, INSTALL_RECORD), JSON.stringify(record(item), null, 2) + "\n");
  }
  const tmpParent = path.join(root, "..", "staging");
  for (const item of staged) replaceDir(item.dir, path.join(root, item.pack.id), tmpParent);
  return { ok: true, ids: staged.map((item) => item.pack.id) };
}

function reasonOf(error: unknown): string {
  if (error instanceof Refusal) return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function withStaging(root: string, work: (staging: string) => Promise<InstallResult> | InstallResult): Promise<InstallResult> {
  let staging: string | null = null;
  try {
    staging = makeStaging(root);
    return await work(staging);
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Public API

/** Copy a folder (never referenced) into staging, validate, install. */
export function installFromFolder(src: string, root: string): Promise<InstallResult> {
  return withStaging(root, (staging) => {
    const from = path.resolve(src);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(from);
    } catch {
      refuse("folder not found");
    }
    if (stat.isSymbolicLink()) refuse("folder is a symlink");
    if (!stat.isDirectory()) refuse("not a folder");
    copyTree(from, staging);
    return commit(staging, root, (item) => ({ kind: "folder", from, sha256: sha256(item.manifestBytes), at: nowIso() }));
  });
}

/** Resolve the highest semver tag of a public GitHub repo, download that tag's tarball, stage, validate, install. */
export function installFromRepo(url: string, root: string, fetchImpl: typeof fetch = fetch): Promise<InstallResult> {
  const repo = parseGitHubRepoUrl(url);
  if (!repo) return Promise.resolve({ ok: false, reason: "only https://github.com/<owner>/<repo> is accepted" });
  return withStaging(root, async (staging) => {
    const tag = highestSemverTag(await fetchTags(repo.owner, repo.repo, fetchImpl));
    if (!tag) refuse("no semver tag");
    const tarball = await fetchTarball(repo.owner, repo.repo, tag, fetchImpl);
    let tar: Buffer;
    try {
      tar = gunzipSync(tarball, { maxOutputLength: TAR_OUTPUT_BYTES });
    } catch {
      refuse("archive: not a gzip tarball or unpacks too large");
    }
    writeEntries(readTar(tar), staging);
    const digest = sha256(tarball);
    return commit(staging, root, () => ({ kind: "repo", from: repo.canonical, tag, sha256: digest, at: nowIso() }));
  });
}

export function removePack(id: string, root: string): { ok: boolean; reason?: string } {
  if (!PACK_ID.test(id)) return { ok: false, reason: "bad id" };
  const dir = path.join(root, id);
  try {
    if (!fs.lstatSync(dir).isDirectory()) return { ok: false, reason: "not installed" };
  } catch {
    return { ok: false, reason: "not installed" };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

function installedVersion(root: string, id: string): string {
  const manifest = readPackJson(path.join(root, id));
  const version = manifest && manifest.raw && typeof manifest.raw === "object" ? (manifest.raw as { version?: unknown }).version : undefined;
  return typeof version === "string" ? version : "";
}

export async function checkPackUpdate(id: string, root: string, fetchImpl: typeof fetch = fetch): Promise<UpdateCheck> {
  if (!PACK_ID.test(id)) return { ok: false, current: "", reason: "bad id" };
  const current = installedVersion(root, id);
  const record = readInstallRecord(path.join(root, id));
  if (!record) return { ok: false, current, reason: "not installed" };
  if (record.kind !== "repo") return { ok: false, current, reason: "installed from a folder" };
  const repo = parseGitHubRepoUrl(record.from);
  if (!repo) return { ok: false, current, reason: "install record has no repository" };
  try {
    const latest = highestSemverTag(await fetchTags(repo.owner, repo.repo, fetchImpl));
    if (!latest) return { ok: false, current, reason: "no semver tag" };
    return { ok: true, current, latest };
  } catch (error) {
    return { ok: false, current, reason: reasonOf(error) };
  }
}

function sourcesOf(root: string, id: string): PackSource[] | null {
  const manifest = readPackJson(path.join(root, id));
  if (!manifest) return null;
  const parsed = parseWorkshopPack(manifest.raw, id);
  return parsed.ok ? parsed.pack.sources : null;
}

/** Re-install from the recorded repository. `sourcesChanged` means the grant must be re-confirmed. */
export async function updatePack(id: string, root: string, fetchImpl: typeof fetch = fetch): Promise<UpdateResult> {
  if (!PACK_ID.test(id)) return { ok: false, reason: "bad id" };
  const record = readInstallRecord(path.join(root, id));
  if (!record) return { ok: false, reason: "not installed" };
  if (record.kind !== "repo") return { ok: false, reason: "installed from a folder" };
  const before = sourcesOf(root, id);
  const result = await installFromRepo(record.from, root, fetchImpl);
  if (!result.ok) return result;
  const after = result.ids.includes(id) ? sourcesOf(root, id) : null;
  const sourcesChanged = !before || !after || JSON.stringify(before) !== JSON.stringify(after);
  return { ...result, sourcesChanged };
}

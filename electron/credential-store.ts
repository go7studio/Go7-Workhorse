import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./state-persistence";

export type SecretCipher = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

type StoredCredential = { ciphertext: string; updatedAt: number };
type CredentialFile = { version: 1; credentials: Record<string, StoredCredential> };

function emptyFile(): CredentialFile {
  return { version: 1, credentials: {} };
}

export class CredentialStore {
  private loaded: CredentialFile | null = null;
  private readonly memory = new Map<string, string>();
  private encryptionAvailable = false;

  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
    private readonly memoryOnly = false,
  ) {}

  available(): boolean {
    if (this.memoryOnly || this.encryptionAvailable) return true;
    this.encryptionAvailable = this.cipher.isEncryptionAvailable();
    return this.encryptionAvailable;
  }

  /** False in Dev / test volatile mode: secrets stay in process memory only. */
  persists(): boolean {
    return !this.memoryOnly;
  }

  put(secret: string, preferredId?: string): string {
    const value = secret.trim();
    if (!value) throw new Error("Cannot store an empty credential.");
    const id = preferredId?.trim() || `credential-${crypto.randomUUID()}`;
    if (this.memoryOnly) {
      this.memory.set(id, value);
      return id;
    }
    if (!this.available()) throw new Error("OS credential encryption is unavailable.");
    const state = this.read();
    if (this.memory.get(id) === value && state.credentials[id]?.ciphertext) return id;
    state.credentials[id] = {
      ciphertext: this.cipher.encryptString(value).toString("base64"),
      updatedAt: Date.now(),
    };
    this.memory.set(id, value);
    this.write(state);
    return id;
  }

  get(id: string | undefined): string {
    const key = id?.trim();
    if (!key) return "";
    const cached = this.memory.get(key);
    if (cached !== undefined) return cached;
    if (this.memoryOnly) return "";
    const row = this.read().credentials[key];
    if (!row?.ciphertext) return "";
    // Avoid touching the OS keychain on ordinary startup when no matching
    // credential exists. On macOS that probe can wait for a keychain agent.
    if (!this.available()) return "";
    try {
      const value = this.cipher.decryptString(Buffer.from(row.ciphertext, "base64"));
      this.memory.set(key, value);
      return value;
    } catch {
      return "";
    }
  }

  remove(id: string | undefined): void {
    const key = id?.trim();
    if (!key) return;
    this.memory.delete(key);
    if (this.memoryOnly) {
      return;
    }
    const state = this.read();
    if (!state.credentials[key]) return;
    delete state.credentials[key];
    this.write(state);
  }

  /** Remove encrypted entries in a reserved namespace that state no longer references. */
  prune(prefix: string, keep: ReadonlySet<string>): void {
    for (const id of [...this.memory.keys()]) {
      if (id.startsWith(prefix) && !keep.has(id)) this.memory.delete(id);
    }
    if (this.memoryOnly) return;
    const state = this.read();
    let changed = false;
    for (const id of Object.keys(state.credentials)) {
      if (!id.startsWith(prefix) || keep.has(id)) continue;
      delete state.credentials[id];
      changed = true;
    }
    if (changed) this.write(state);
  }

  private read(): CredentialFile {
    if (this.loaded) return this.loaded;
    for (const candidate of [this.file, `${this.file}.bak`]) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as Partial<CredentialFile>;
        if (!parsed.credentials || typeof parsed.credentials !== "object") continue;
        this.loaded = { version: 1, credentials: parsed.credentials };
        if (candidate !== this.file) {
          try { atomicWriteJson(this.file, this.loaded, 0o600); } catch { /* backup remains valid */ }
        }
        return this.loaded;
      } catch {
        continue;
      }
    }
    this.loaded = emptyFile();
    return this.loaded;
  }

  private write(state: CredentialFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      const previous = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<CredentialFile>;
      if (previous.credentials && typeof previous.credentials === "object") {
        atomicWriteJson(`${this.file}.bak`, { version: 1, credentials: previous.credentials }, 0o600);
      }
    } catch {
      /* first write or corrupt primary */
    }
    atomicWriteJson(this.file, state, 0o600);
  }
}

type LooseRecord = Record<string, unknown>;

function record(value: unknown): LooseRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseRecord) : null;
}

function cloneState<T>(value: T): T {
  return structuredClone(value);
}

function secureRow(row: LooseRecord, vault: CredentialStore, fallbackId: string): void {
  const secret = typeof row.apiKey === "string" ? row.apiKey.trim() : "";
  let credentialId = typeof row.credentialId === "string" ? row.credentialId.trim() : "";
  if (secret) credentialId = vault.put(secret, credentialId || fallbackId);
  if (credentialId) row.credentialId = credentialId;
  // A memory-only vault cannot reload the secret after quit. Leaving the key
  // on the row is how Dev keeps a pasted Synthetic/Kimi key across restarts.
  if (vault.persists()) delete row.apiKey;
}

function hydrateRow(row: LooseRecord, vault: CredentialStore): void {
  const legacy = typeof row.apiKey === "string" ? row.apiKey.trim() : "";
  const credentialId = typeof row.credentialId === "string" ? row.credentialId.trim() : "";
  row.apiKey = legacy || vault.get(credentialId);
}

function mcpCredentialId(serverName: string, envName: string): string {
  const stable = crypto.createHash("sha256").update(`${serverName}\0${envName}`).digest("hex").slice(0, 24);
  return `mcp-env-${stable}`;
}

function secureMcpRow(row: LooseRecord, vault: CredentialStore): void {
  const name = typeof row.name === "string" ? row.name : "server";
  const env = record(row.env) ?? {};
  const existing = record(row.envCredentialIds) ?? {};
  const ids: Record<string, string> = {};
  for (const [envName, rawValue] of Object.entries(env)) {
    const secret = typeof rawValue === "string" ? rawValue.trim() : "";
    const prior = typeof existing[envName] === "string" ? String(existing[envName]).trim() : "";
    if (secret) ids[envName] = vault.put(secret, prior || mcpCredentialId(name, envName));
    else if (prior) ids[envName] = prior;
  }
  for (const [envName, rawId] of Object.entries(existing)) {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (id && !ids[envName]) ids[envName] = id;
  }
  if (Object.keys(ids).length > 0) row.envCredentialIds = ids;
  if (vault.persists()) delete row.env;
}

function hydrateMcpRow(row: LooseRecord, vault: CredentialStore): void {
  const legacy = record(row.env) ?? {};
  const ids = record(row.envCredentialIds) ?? {};
  const env: Record<string, string> = {};
  for (const [envName, rawValue] of Object.entries(legacy)) {
    if (typeof rawValue === "string" && rawValue) env[envName] = rawValue;
  }
  for (const [envName, rawId] of Object.entries(ids)) {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!env[envName] && id) {
      const value = vault.get(id);
      if (value) env[envName] = value;
    }
  }
  if (Object.keys(env).length > 0) row.env = env;
}

/** Return a clone safe to write to workhorse-state.json. */
export function protectStateCredentials<T extends LooseRecord>(state: T, vault: CredentialStore): T {
  const next = cloneState(state);
  const settings = record(next.settings);
  const llms = record(settings?.llms);
  const custom = record(llms?.custom);
  if (custom) secureRow(custom, vault, "custom-default");
  const bots = settings?.customBots;
  if (Array.isArray(bots)) {
    for (const item of bots) {
      const bot = record(item);
      if (!bot) continue;
      const id = typeof bot.id === "string" && bot.id.trim() ? bot.id.trim() : crypto.randomUUID();
      secureRow(bot, vault, `custom-bot-${id}`);
    }
  }
  const mcpServers = settings?.mcpServers;
  if (Array.isArray(mcpServers)) {
    const activeMcpCredentialIds = new Set<string>();
    for (const item of mcpServers) {
      const server = record(item);
      if (!server) continue;
      secureMcpRow(server, vault);
      const ids = record(server.envCredentialIds) ?? {};
      for (const rawId of Object.values(ids)) {
        if (typeof rawId === "string" && rawId.startsWith("mcp-env-")) activeMcpCredentialIds.add(rawId);
      }
    }
    vault.prune("mcp-env-", activeMcpCredentialIds);
  }
  return next;
}

function redactStateCredentials<T extends LooseRecord>(state: T): T {
  const next = cloneState(state);
  const settings = record(next.settings);
  const llms = record(settings?.llms);
  const custom = record(llms?.custom);
  if (custom) delete custom.apiKey;
  const bots = settings?.customBots;
  if (Array.isArray(bots)) {
    for (const item of bots) {
      const bot = record(item);
      if (bot) delete bot.apiKey;
    }
  }
  const mcpServers = settings?.mcpServers;
  if (Array.isArray(mcpServers)) {
    for (const item of mcpServers) {
      const server = record(item);
      if (server) delete server.env;
    }
  }
  return next;
}

/** Keep non-secret desk state durable while a locked OS vault stays read-only. */
export function protectStateCredentialsForSave<T extends LooseRecord>(state: T, vault: CredentialStore): T {
  try {
    return protectStateCredentials(state, vault);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "OS credential encryption is unavailable.") throw error;
    return redactStateCredentials(state);
  }
}

/** Return a clone hydrated for the renderer; legacy plaintext remains migratable. */
export function hydrateStateCredentials<T extends LooseRecord>(state: T, vault: CredentialStore): T {
  const next = cloneState(state);
  const settings = record(next.settings);
  const llms = record(settings?.llms);
  const custom = record(llms?.custom);
  if (custom) hydrateRow(custom, vault);
  const bots = settings?.customBots;
  if (Array.isArray(bots)) {
    for (const item of bots) {
      const bot = record(item);
      if (bot) hydrateRow(bot, vault);
    }
  }
  const mcpServers = settings?.mcpServers;
  if (Array.isArray(mcpServers)) {
    for (const item of mcpServers) {
      const server = record(item);
      if (server) hydrateMcpRow(server, vault);
    }
  }
  return next;
}

#!/usr/bin/env node
/**
 * Restore Dev desk settings/keys from stable + a prior Dev snapshot.
 * Usage: node scripts/merge-dev-settings.mjs <destUserData> [sourceA sourceB ...]
 */
import fs from "node:fs";
import path from "node:path";

const destRoot = process.argv[2];
const sources = process.argv.slice(3);
if (!destRoot || sources.length === 0) {
  process.stderr.write("usage: node scripts/merge-dev-settings.mjs <dest> <source...>\n");
  process.exit(1);
}

function readState(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "workhorse-state.json"), "utf8"));
}

function writeState(root, state) {
  fs.writeFileSync(path.join(root, "workhorse-state.json"), JSON.stringify(state));
}

function botKey(sourceBots, id) {
  const row = (sourceBots ?? []).find((item) => item?.id === id);
  return typeof row?.apiKey === "string" ? row.apiKey.trim() : "";
}

function mergeCustomBots(currentBots, stableBots, keyBots) {
  const byId = new Map();
  for (const bot of stableBots ?? []) {
    if (!bot || typeof bot !== "object") continue;
    const id = typeof bot.id === "string" ? bot.id.trim() : "";
    const baseUrl = typeof bot.baseUrl === "string" ? bot.baseUrl.trim() : "";
    const model = typeof bot.model === "string" ? bot.model.trim() : "";
    const credentialId = typeof bot.credentialId === "string" ? bot.credentialId.trim() : "";
    const apiKey = botKey(keyBots, id);
    if (!id || !baseUrl || !model) continue;
    if (!credentialId && !apiKey) continue;
    byId.set(id, {
      ...bot,
      ...(apiKey ? { apiKey } : {}),
      enabled: bot.enabled !== false,
    });
  }
  for (const bot of currentBots ?? []) {
    if (!bot || typeof bot !== "object") continue;
    const id = typeof bot.id === "string" ? bot.id.trim() : "";
    if (!id || byId.has(id)) continue;
    const baseUrl = typeof bot.baseUrl === "string" ? bot.baseUrl.trim() : "";
    const model = typeof bot.model === "string" ? bot.model.trim() : "";
    const credentialId = typeof bot.credentialId === "string" ? bot.credentialId.trim() : "";
    const apiKey = typeof bot.apiKey === "string" ? bot.apiKey.trim() : botKey(keyBots, id);
    if (!baseUrl || !model) continue;
    if (!credentialId && !apiKey) continue;
    byId.set(id, {
      ...bot,
      ...(apiKey ? { apiKey } : {}),
      enabled: bot.enabled !== false,
    });
  }
  return [...byId.values()];
}

function mergeLlms(stableLlms, currentLlms) {
  const ids = ["grok", "codex", "claude", "cursor", "custom"];
  const out = {};
  for (const id of ids) {
    out[id] = {
      ...(currentLlms?.[id] ?? {}),
      ...(stableLlms?.[id] ?? {}),
      connected: stableLlms?.[id]?.connected !== false || currentLlms?.[id]?.connected === true,
      enabled: stableLlms?.[id]?.enabled !== false,
    };
  }
  if (out.custom) out.custom.connected = false;
  return out;
}

const dest = readState(destRoot);
const stable = readState(sources[0]);
const keySource = sources.find((root) => {
  try {
    const bots = readState(root).settings?.customBots;
    return Array.isArray(bots) && bots.some((bot) => typeof bot?.apiKey === "string" && bot.apiKey.trim());
  } catch {
    return false;
  }
});
const keyBots = keySource ? readState(keySource).settings?.customBots : [];

dest.settings = {
  ...dest.settings,
  ...stable.settings,
  llms: mergeLlms(stable.settings?.llms, dest.settings?.llms),
  customBots: mergeCustomBots(dest.settings?.customBots, stable.settings?.customBots, keyBots),
  routing: {
    ...(stable.settings?.routing ?? {}),
    ...(dest.settings?.routing ?? {}),
    enabled: true,
  },
};

dest.deskPlans = stable.deskPlans ?? dest.deskPlans;
dest.usage = Array.isArray(stable.usage) && stable.usage.length > 0 ? stable.usage : dest.usage;
dest.usageBudgets = stable.settings?.usageBudgets ?? dest.settings?.usageBudgets;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(destRoot, `_backup-before-settings-merge-${stamp}`);
fs.mkdirSync(backup, { recursive: true });
fs.copyFileSync(path.join(destRoot, "workhorse-state.json"), path.join(backup, "workhorse-state.json"));

writeState(destRoot, dest);

for (const srcRoot of sources) {
  const cred = path.join(srcRoot, "credentials.json");
  if (fs.existsSync(cred)) {
    fs.copyFileSync(cred, path.join(destRoot, "credentials.json"));
    if (fs.existsSync(`${cred}.bak`)) fs.copyFileSync(`${cred}.bak`, path.join(destRoot, "credentials.json.bak"));
    break;
  }
}

process.stdout.write(
  [
    `settings merged into ${destRoot}`,
    `bots=${dest.settings.customBots.length}`,
    `routing.enabled=${dest.settings.routing.enabled}`,
    `stock connected=${["grok", "codex", "claude", "cursor"].map((id) => `${id}:${dest.settings.llms[id].connected}`).join(" ")}`,
    `keys from=${keySource ?? "none"}`,
    `backup=${backup}`,
  ].join("\n") + "\n",
);

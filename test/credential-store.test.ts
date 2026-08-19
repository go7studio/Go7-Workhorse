import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CredentialStore, hydrateStateCredentials, protectStateCredentials, type SecretCipher } from "../electron/credential-store";

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`locked:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^locked:/, ""),
};

test("custom API credentials leave normal state and round-trip through the encrypted vault", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-credentials-"));
  const file = path.join(root, "credentials.json");
  const vault = new CredentialStore(file, cipher);
  const original = {
    settings: {
      llms: { custom: { baseUrl: "https://example.test", model: "model", apiKey: "default-secret" } },
      customBots: [{ id: "bot-1", baseUrl: "https://example.test", model: "model", apiKey: "bot-secret" }],
    },
  };
  const protectedState = protectStateCredentials(original, vault);
  const serializedState = JSON.stringify(protectedState);
  assert.doesNotMatch(serializedState, /default-secret|bot-secret/);
  assert.match(serializedState, /credentialId/);
  const serializedVault = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(serializedVault, /default-secret|bot-secret/);

  const hydrated = hydrateStateCredentials(protectedState, new CredentialStore(file, cipher));
  assert.equal(hydrated.settings.llms.custom.apiKey, "default-secret");
  assert.equal(hydrated.settings.customBots[0]?.apiKey, "bot-secret");
  fs.rmSync(root, { recursive: true, force: true });
});

test("credential protection refuses plaintext persistence when OS encryption is unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-credentials-off-"));
  const unavailable: SecretCipher = { ...cipher, isEncryptionAvailable: () => false };
  const vault = new CredentialStore(path.join(root, "credentials.json"), unavailable);
  assert.throws(
    () => protectStateCredentials({ settings: { llms: { custom: { apiKey: "secret" } }, customBots: [] } }, vault),
    /unavailable/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("volatile credential mode keeps secrets in memory and never creates a vault file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-credentials-volatile-"));
  const file = path.join(root, "credentials.json");
  const vault = new CredentialStore(file, cipher, true);
  const protectedState = protectStateCredentials(
    { settings: { llms: { custom: { apiKey: "session-secret" } }, customBots: [{ id: "bot-kimi", apiKey: "syn_live" }] } },
    vault,
  );
  assert.equal(fs.existsSync(file), false);
  // The vault is memory-only, so the key stays on the row. A restart of the
  // same state file can still hydrate it — Dev used to strip it and lose Kimi.
  assert.equal(protectedState.settings.llms.custom.apiKey, "session-secret");
  assert.equal(protectedState.settings.customBots[0].apiKey, "syn_live");
  assert.equal(hydrateStateCredentials(protectedState, vault).settings.llms.custom.apiKey, "session-secret");
  assert.equal(
    hydrateStateCredentials(protectedState, new CredentialStore(file, cipher, true)).settings.customBots[0].apiKey,
    "syn_live",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("credential vault recovers its last encrypted generation after corruption", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-credentials-recover-"));
  const file = path.join(root, "credentials.json");
  const vault = new CredentialStore(file, cipher);
  vault.put("first-secret", "custom-default");
  vault.put("second-secret", "custom-default");
  fs.writeFileSync(file, "{broken", "utf8");
  const recovered = new CredentialStore(file, cipher);
  assert.equal(recovered.get("custom-default"), "first-secret");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /first-secret|second-secret/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("credential access opens the OS vault once per secret and reuses the decrypted value", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-credentials-cache-"));
  const file = path.join(root, "credentials.json");
  const calls = { available: 0, encrypt: 0, decrypt: 0 };
  const counted: SecretCipher = {
    isEncryptionAvailable: () => {
      calls.available += 1;
      return true;
    },
    encryptString: (value) => {
      calls.encrypt += 1;
      return Buffer.from(`locked:${value}`, "utf8");
    },
    decryptString: (value) => {
      calls.decrypt += 1;
      return value.toString("utf8").replace(/^locked:/, "");
    },
  };
  new CredentialStore(file, counted).put("secret", "custom-default");
  const restarted = new CredentialStore(file, counted);
  assert.equal(restarted.get("custom-default"), "secret");
  assert.equal(restarted.get("custom-default"), "secret");
  restarted.put("secret", "custom-default");
  assert.deepEqual(calls, { available: 2, encrypt: 1, decrypt: 1 });
  fs.rmSync(root, { recursive: true, force: true });
});

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { cursorLanePlan, leftoverFetchKnown, leftoverForCard, leftoverMissingCopy, planWindowChip, weeklyPlanLeftover } from "../src/lib/usage";
import { parseClaudePlanUsage } from "../electron/claude-plan";
import { leftoverFromRemainingPercent, parseCustomPlanUsage } from "../electron/custom-plan";
import {
  fetchGrokPlanUsage,
  GROK_BILLING_URL,
  GROK_CLI_TOKEN_AUTH,
  grokBillingHeaders,
  sameHttpsOrigin,
} from "../electron/grok-plan";
import { CUSTOM_METERS } from "../src/lib/custom-meters";
import { PROVIDER_PRESETS } from "../src/lib/provider-catalog";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public Workhorse does not ship vendor-meter; leftover parsers stay shipped", () => {
  assert.equal(existsSync(path.join(ROOT, "skills", "vendor-meter", "SKILL.md")), false);
  assert.match(readFileSync(path.join(ROOT, "skills", "setup", "SKILL.md"), "utf8"), /skills hub/);
});

test("official Claude MiniMax and Synthetic fixtures invert leftover; missing stays unknown", () => {
  const claude = parseClaudePlanUsage({
    five_hour: { utilization: 0.18, resets_at: "2026-09-12T00:00:00Z" },
    seven_day: { utilization: 18, resets_at: "2026-09-12T00:00:00Z" },
  });
  assert.equal(claude?.usedPercent, 18);
  assert.equal(claude?.leftPercent, 82);
  const statusline = parseClaudePlanUsage({
    rate_limits: {
      five_hour: { used_percentage: 18, resets_at: 1_789_171_200 },
      seven_day: { used_percentage: 18, resets_at: 1_789_171_200 },
    },
  });
  assert.equal(statusline?.usedPercent, 18);
  assert.equal(statusline?.leftPercent, 82);
  const onePercent = parseClaudePlanUsage({
    rate_limits: { seven_day: { used_percentage: 1 } },
  });
  assert.equal(onePercent?.usedPercent, 1);
  assert.equal(onePercent?.leftPercent, 99);
  assert.equal(parseClaudePlanUsage(null), undefined);
  assert.equal(parseClaudePlanUsage({}), undefined);
  assert.equal(parseClaudePlanUsage({ error: { status: 404 } }), undefined);

  assert.equal(leftoverFromRemainingPercent(54), 54);
  const mini = parseCustomPlanUsage({
    model_remains: [{ model_name: "general", current_weekly_remaining_percent: 54, current_interval_remaining_percent: 80 }],
  });
  assert.equal(mini?.leftPercent, 54);
  assert.equal(mini?.usedPercent, 46);
  assert.equal(parseCustomPlanUsage(null), undefined);
  assert.equal(parseCustomPlanUsage({}), undefined);
  assert.equal(parseCustomPlanUsage({ error: 404 }), undefined);

  const syn = parseCustomPlanUsage({
    subscription: { limit: 50, requests: 23, renewsAt: "2026-09-12T00:00:00Z" },
  });
  assert.equal(syn?.usedPercent, 46);
  assert.equal(syn?.leftPercent, 54);
  assert.equal(parseCustomPlanUsage({ subscription: { limit: 0, requests: 0 } }), undefined);
  assert.equal(parseCustomPlanUsage({ subscription: { requests: 10 } }), undefined);
});

test("Claude MiniMax and Synthetic leftovers stay on their own rings", () => {
  const claudePlan = parseClaudePlanUsage({ seven_day: { utilization: 18 } });
  const miniPlan = parseCustomPlanUsage({
    model_remains: [{ model_name: "general", current_weekly_remaining_percent: 54 }],
  });
  const synPlan = parseCustomPlanUsage({ subscription: { limit: 100, requests: 20 } });
  const plans = {
    grok: { usedPercent: 99, leftPercent: 1, period: "weekly" as const, prepaidBalance: 0, products: [] },
    cursor: {
      usedPercent: 90,
      leftPercent: 10,
      period: "monthly" as const,
      prepaidBalance: 0,
      products: [{ product: "cursor-models", label: "Cursor Models", usagePercent: 90 }],
    },
    claude: claudePlan,
    custom: { bot_mini: miniPlan, bot_syn: synPlan },
  };
  const claude = leftoverForCard({ focus: "claude", provider: "claude", key: "claude" }, plans);
  const mini = leftoverForCard({ focus: "bot:bot_mini", provider: "custom", key: "bot_mini" }, plans);
  const syn = leftoverForCard({ focus: "bot:bot_syn", provider: "custom", key: "bot_syn" }, plans);
  assert.equal(claude?.leftPercent, 82);
  assert.equal(mini?.leftPercent, 54);
  assert.equal(syn?.leftPercent, 80);
  assert.notEqual(claude?.leftPercent, plans.grok.leftPercent);
  assert.notEqual(mini?.leftPercent, leftoverForCard({ focus: "cursor:cursor-models", provider: "cursor", key: "cursor:cursor-models" }, plans)?.leftPercent);
  const pane = readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  assert.match(pane, /leftoverForCard/);
  const cursorChip = planWindowChip(
    leftoverForCard({ focus: "cursor:cursor-models", provider: "cursor", key: "cursor:cursor-models" }, plans),
    { provider: "cursor" },
  );
  // The chip is leftover, like the ring above it: 90% spent is 10% left.
  assert.match(cursorChip ?? "", /10%/);
});

test("prepaid custom meters fill balance and do not invent leftover percent", () => {
  const deepseek = parseCustomPlanUsage({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "42.50", granted_balance: "2.50", topped_up_balance: "40.00" }],
  });
  assert.equal(deepseek?.prepaidBalance, 42.5);
  assert.equal(Number.isFinite(deepseek?.leftPercent), false);
  assert.equal(weeklyPlanLeftover(deepseek), undefined);

  const novita = parseCustomPlanUsage({ availableBalance: "1000000", cashBalance: "800000" });
  assert.equal(novita?.prepaidBalance, 100);
  assert.equal(weeklyPlanLeftover(novita), undefined);

  const aiml = parseCustomPlanUsage({ current_balance: 12.25, currency: "USD" }, undefined, "aimlapi");
  assert.equal(aiml?.prepaidBalance, 12.25);
  assert.equal(weeklyPlanLeftover(aiml), undefined);

  const plans = {
    custom: { bot_ds: deepseek, bot_nv: novita, bot_al: aiml },
  };
  assert.equal(leftoverForCard({ focus: "bot:bot_ds", provider: "custom", key: "bot_ds" }, plans)?.prepaidBalance, 42.5);
  assert.notEqual(
    leftoverForCard({ focus: "bot:bot_ds", provider: "custom", key: "bot_ds" }, plans)?.prepaidBalance,
    leftoverForCard({ focus: "bot:bot_nv", provider: "custom", key: "bot_nv" }, plans)?.prepaidBalance,
  );
});

// A missing official meter stays unknown, and a 404 is not empty. Before the
// built-in vendors had a `vendorPlanKnown` mark, a failed Grok/Claude/Codex/
// Cursor fetch read "Loading weekly plan usage…" forever.
test("a built-in meter that answered reads unknown, never a permanent Loading", () => {
  const nothingFetched: Record<string, boolean> = {};
  const answered: Record<string, boolean> = { grok: true, codex: true, claude: true, cursor: true };
  const copyFor = (provider: "grok" | "codex" | "claude" | "cursor", vendorPlanKnown: Record<string, boolean>) =>
    leftoverMissingCopy({
      hasKey: true,
      fetchKnown: leftoverFetchKnown({ provider, vendorPlanKnown, customPlanKnown: {} }),
      canLoad: true,
      planName: "SuperGrok",
    });

  for (const provider of ["grok", "codex", "claude", "cursor"] as const) {
    // Nothing has been asked yet, so "Loading" is still honest.
    assert.equal(leftoverFetchKnown({ provider, vendorPlanKnown: nothingFetched, customPlanKnown: {} }), false);
    assert.match(copyFor(provider, nothingFetched), /Loading weekly plan usage/);
    // The fetch settled with no plan: a 404, an auth failure, or a dead socket.
    assert.equal(leftoverFetchKnown({ provider, vendorPlanKnown: answered, customPlanKnown: {} }), true);
    assert.match(copyFor(provider, answered), /Couldn't read weekly leftover/);
    assert.doesNotMatch(copyFor(provider, answered), /Loading/);
  }

  // Custom bots keep their own per-bot map and are not swept in by a vendor mark.
  assert.equal(
    leftoverFetchKnown({ provider: "custom", botId: "bot_mini", vendorPlanKnown: answered, customPlanKnown: {} }),
    false,
  );
  assert.equal(
    leftoverFetchKnown({
      provider: "custom",
      botId: "bot_mini",
      vendorPlanKnown: nothingFetched,
      customPlanKnown: { bot_mini: true },
    }),
    true,
  );
  assert.equal(
    leftoverFetchKnown({ provider: "custom", vendorPlanKnown: nothingFetched, customPlanKnown: { bot_mini: true } }),
    false,
  );

  // Cursor's two pools share one fetch, so an answered meter marks both lanes
  // known even when one lane's product is absent from the payload.
  const cursorOneLane = {
    usedPercent: 90,
    leftPercent: 10,
    period: "monthly" as const,
    prepaidBalance: 0,
    products: [{ product: "cursor-models", label: "Cursor Models", usagePercent: 90 }],
  };
  assert.equal(cursorLanePlan(cursorOneLane, "cursor:cursor-models")?.leftPercent, 10);
  assert.equal(cursorLanePlan(cursorOneLane, "cursor:other-models"), undefined);
  assert.equal(leftoverFetchKnown({ provider: "cursor", vendorPlanKnown: answered, customPlanKnown: {} }), true);

  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /const \[vendorPlanKnown, setVendorPlanKnown\]/);
  for (const provider of ["grok", "codex", "claude", "cursor"]) {
    // Marked on both the resolve and the reject arm: settled either way is known.
    const marks = store.match(new RegExp(`markVendorPlanKnown\\("${provider}"\\)`, "g")) ?? [];
    assert.ok(marks.length >= 2, `${provider} marks its meter known on success and on failure`);
  }

  const pane = readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  assert.match(pane, /useStoreSelector\(selectUsageDesk, sameUsageDesk\)/);
  assert.match(pane, /leftoverFetchKnown\(\{/);
  assert.match(pane, /vendorPlanKnown,/);
  assert.doesNotMatch(pane, /fetchKnown: focused\.provider === "custom"/);
  // No invented ring: an unread meter draws nothing and reads "…", not 0%.
  assert.match(pane, /value=\{plan \? plan\.leftPercent \/ 100 : undefined\}/);
  assert.match(pane, /leftoverUnknownMark/);
  assert.match(pane, /missing\?\.label \?\? "…"/);
});

test("an answered meter that carries a plan still fills its ring", () => {
  const claudePlan = parseClaudePlanUsage({ seven_day: { utilization: 18 } });
  const plans = {
    claude: claudePlan,
    grok: { usedPercent: 60, leftPercent: 40, period: "weekly" as const, prepaidBalance: 0, products: [] },
  };
  // Known and fetched are the same mark; the ring reads the plan, not the mark.
  assert.equal(leftoverFetchKnown({ provider: "claude", vendorPlanKnown: { claude: true }, customPlanKnown: {} }), true);
  assert.equal(leftoverForCard({ focus: "claude", provider: "claude", key: "claude" }, plans)?.leftPercent, 82);
  assert.equal(leftoverForCard({ focus: "grok", provider: "grok", key: "grok" }, plans)?.leftPercent, 40);
  assert.equal(weeklyPlanLeftover(claudePlan), 82);
});

test("custom leftover meters are a closed official list and catalog hosts stay custom bots", () => {
  assert.deepEqual(
    CUSTOM_METERS.map((item) => item.id),
    ["minimax", "synthetic", "openrouter", "deepseek", "novita", "aimlapi", "vercel"],
  );
  const ids = PROVIDER_PRESETS.map((item) => item.id);
  for (const id of ["minimax", "synthetic", "openrouter", "groq", "deepseek", "together", "fireworks", "huggingface", "novita", "cerebras", "aimlapi", "vercel", "kimi", "gemini", "grok-bot"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(ids.includes("openclaw"), false);
  assert.equal(ids.includes("hermes"), false);
});

const GROK_HOME = path.join(path.sep, "Users", "nobody");
const GROK_AUTH = path.join(GROK_HOME, ".grok", "auth.json");

function grokAuthFixture(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    "https://auth.x.ai::acct": {
      key: "expired-grok-token",
      user_id: "user-123",
      refresh_token: "grok-refresh-token",
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "grok-cli",
      principal_type: "User",
      principal_id: "user-123",
      expires_at: "2026-08-30T00:00:00.000Z",
      ...overrides,
    },
  });
}

function grokAuthInput(authJson: string, fetchImpl: typeof fetch, extra: Parameters<typeof fetchGrokPlanUsage>[0] = {}) {
  return {
    env: {},
    homedir: GROK_HOME,
    existsSync: (filePath: string) => filePath === GROK_AUTH,
    readFile: (filePath: string) => {
      if (filePath !== GROK_AUTH) throw new Error("must not read the machine");
      return authJson;
    },
    writeFile: () => {
      throw new Error("must not write auth unless the test expects it");
    },
    fetchImpl,
    now: Date.parse("2026-09-02T15:00:00.000Z"),
    ...extra,
  };
}

test("fetchGrokPlanUsage stays unknown without a login and never hits the network", async () => {
  const plan = await fetchGrokPlanUsage({
    env: {},
    homedir: GROK_HOME,
    existsSync: () => false,
    readFile: () => {
      throw new Error("must not read the machine");
    },
    fetchImpl: async () => {
      throw new Error("must not fetch without a token");
    },
  });
  assert.equal(plan, undefined);
});

test("fetchGrokPlanUsage sends Grok CLI session headers and reads SuperGrok leftover", async () => {
  assert.equal(sameHttpsOrigin("https://auth.x.ai", "https://auth.x.ai/oauth/token"), true);
  assert.equal(sameHttpsOrigin("https://auth.x.ai", "http://auth.x.ai/oauth/token"), false);
  assert.equal(sameHttpsOrigin("https://auth.x.ai", "https://evil.example/token"), false);
  const headers = grokBillingHeaders("live-token", "user-123");
  assert.equal(headers["X-XAI-Token-Auth"], GROK_CLI_TOKEN_AUTH);
  assert.equal(headers["x-userid"], "user-123");
  assert.equal(headers["x-grok-client-mode"], "headless");
  assert.match(headers["User-Agent"] ?? "", /^Go7-Workhorse\//);
  assert.doesNotMatch(headers["User-Agent"] ?? "", /grok-cli/i);

  const seen: Array<{ url: string; auth: string | null; tokenAuth: string | null; userId: string | null }> = [];
  const plan = await fetchGrokPlanUsage(
    grokAuthInput(grokAuthFixture({ key: "live-token", expires_at: "2026-09-03T00:00:00.000Z" }), async (url, init) => {
      const headerBag = new Headers(init?.headers);
      seen.push({
        url: String(url),
        auth: headerBag.get("authorization"),
        tokenAuth: headerBag.get("x-xai-token-auth"),
        userId: headerBag.get("x-userid"),
      });
      assert.equal(String(url), GROK_BILLING_URL);
      return new Response(
        JSON.stringify({
          config: {
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-08T00:00:00Z" },
            creditUsagePercent: 17,
            productUsage: [{ product: "GrokBuild", usagePercent: 17 }],
          },
        }),
        { status: 200 },
      );
    }),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.auth, "Bearer live-token");
  assert.equal(seen[0]?.tokenAuth, GROK_CLI_TOKEN_AUTH);
  assert.equal(seen[0]?.userId, "user-123");
  assert.equal(plan?.usedPercent, 17);
  assert.equal(plan?.leftPercent, 83);
  assert.equal(plan?.observedAt, "2026-09-02T15:00:00.000Z");
});

test("fetchGrokPlanUsage refreshes an expired OIDC token then reads leftover", async () => {
  const written: string[] = [];
  const urls: string[] = [];
  const plan = await fetchGrokPlanUsage(
    grokAuthInput(
      grokAuthFixture(),
      async (url, init) => {
        urls.push(String(url));
        const headerBag = new Headers(init?.headers);
        if (String(url) === GROK_BILLING_URL) {
          assert.equal(headerBag.get("authorization"), "Bearer fresh-grok-token");
          assert.equal(headerBag.get("x-xai-token-auth"), GROK_CLI_TOKEN_AUTH);
          return new Response(
            JSON.stringify({
              config: {
                remainingPercent: 0,
                productUsage: [{ product: "GrokBuild", remainingPercent: 0 }],
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch ${String(url)}`);
      },
      {
        writeFile: (filePath, contents) => {
          assert.equal(filePath, GROK_AUTH);
          written.push(contents);
        },
        refreshOauth: async (auth) => {
          assert.equal(auth.refreshToken, "grok-refresh-token");
          assert.equal(auth.issuer, "https://auth.x.ai");
          assert.equal(auth.clientId, "grok-cli");
          return {
            accessToken: "fresh-grok-token",
            refreshToken: "rotated-refresh",
            expiresAt: "2026-09-09T15:00:00.000Z",
          };
        },
      },
    ),
  );
  assert.equal(written.length, 1);
  assert.match(written[0] ?? "", /fresh-grok-token/);
  assert.match(written[0] ?? "", /rotated-refresh/);
  assert.deepEqual(urls, [GROK_BILLING_URL]);
  assert.equal(plan?.usedPercent, 100);
  assert.equal(plan?.leftPercent, 0);
});

test("fetchGrokPlanUsage retries billing once after a 401 by refreshing OIDC", async () => {
  const auths: string[] = [];
  let refreshed = 0;
  const plan = await fetchGrokPlanUsage(
    grokAuthInput(
      grokAuthFixture({ key: "stale-grok-token", expires_at: "2026-09-03T00:00:00.000Z" }),
      async (url, init) => {
        const headerBag = new Headers(init?.headers);
        auths.push(headerBag.get("authorization") ?? "");
        assert.equal(String(url), GROK_BILLING_URL);
        if (headerBag.get("authorization") === "Bearer stale-grok-token") {
          return new Response(JSON.stringify({ error: "Invalid or expired credentials" }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            config: {
              currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-08T00:00:00Z" },
              creditUsagePercent: 41,
            },
          }),
          { status: 200 },
        );
      },
      {
        writeFile: () => undefined,
        refreshOauth: async () => {
          refreshed += 1;
          return { accessToken: "fresh-grok-token", expiresAt: "2026-09-09T15:00:00.000Z" };
        },
      },
    ),
  );
  assert.equal(refreshed, 1);
  assert.deepEqual(auths, ["Bearer stale-grok-token", "Bearer fresh-grok-token"]);
  assert.equal(plan?.usedPercent, 41);
  assert.equal(plan?.leftPercent, 59);
});

test("Grok OIDC refresh refuses a token endpoint off the issuer origin", async () => {
  const urls: string[] = [];
  const plan = await fetchGrokPlanUsage(
    grokAuthInput(grokAuthFixture(), async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify({ token_endpoint: "https://evil.example/token" }), { status: 200 });
      }
      if (String(url) === GROK_BILLING_URL) {
        return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }),
  );
  assert.equal(urls.includes("https://evil.example/token"), false);
  assert.ok(urls.includes("https://auth.x.ai/.well-known/openid-configuration"));
  assert.equal(plan, undefined);
});

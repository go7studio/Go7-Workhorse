import { chromium } from 'playwright';
// Build, start `npx vite preview --host 127.0.0.1 --port 4190`, then run this
// script. The renderer is real; vendor turns and desk persistence are fixtures.
const browser = await chromium.launch({ headless: true });
try {
const page = await browser.newPage();
page.on('pageerror', error => console.log('PAGE ERROR', error.message));
await page.addInitScript(() => {
  const base = { projectId: null, provider: 'codex', model: 'gpt-6-astra', mode: 'always-approve', sandbox: 'off', status: 'idle', contextUsed: 0 };
  const saved = { theme: 'dark', activeSessionId: 'parent', projects: [],
    sessions: [
      { ...base, id: 'parent', title: 'Head', messages: [{ id: 'p', role: 'user', text: 'Finish the walkthrough', createdAt: 1 }] },
      { ...base, id: 'worker', parentId: 'parent', hidden: true, title: 'Wren', workerName: 'Wren',
        agentRun: { status: 'completed', startedAt: 1, isolation: 'shared' },
        messages: [{ id: 'w', role: 'user', text: 'Walk through the tutorial', createdAt: 1 }] },
    ], settings: { llms: { codex: { connected: true, enabled: true } } } };
  window.results = { calls: 0, replies: [], snapshots: [] };
  window.workhorse = {
    loadState: async () => saved,
    saveState: async (state) => { window.results.snapshots.push(state); },
    detectCodexLogin: async () => ({ connected: true, accessDefaults: { mode: 'ask', sandbox: 'read-only' } }),
    onPeerAsk: (handler) => { window.ask = handler; return () => {}; },
    onCodexEvent: (handler) => { window.emit = handler; return () => {}; },
    replyPeerAsk: async (reply) => window.results.replies.push(reply),
    codexPrompt: async ({ sessionId }) => {
      const n = ++window.results.calls;
      const text = n === 1 ? 'Walk 3 reached hang overlay and pack.' : 'Verified farewell in final.png.\nMission status: complete';
      window.emit({ type: 'chunk', sessionId, text });
      window.emit({ type: 'done', sessionId, stopReason: 'end_turn' });
      await new Promise(resolve => setTimeout(resolve, n === 1 ? 2300 : 400));
      if (n === 1) window.results.mid = window.results.snapshots.at(-1);
      return { text, stopReason: 'end_turn' };
    },
  };
});
await page.goto(process.argv[2] ?? 'http://127.0.0.1:4190');
await page.waitForFunction(() => window.ask && window.emit);
await page.waitForTimeout(200);
await page.evaluate(() => window.ask({ id: 'ask1', mode: 'ask', fromSessionId: 'parent', toSessionId: 'worker', message: 'Finish the full walkthrough and verify farewell.', wait: false }));
await page.waitForFunction(() => window.results.calls >= 2, null, { timeout: 10000 });
await page.waitForTimeout(2800);
const result = await page.evaluate(() => {
  const latest = window.results.snapshots.at(-1);
  return { calls: window.results.calls, replies: window.results.replies,
    midStatus: window.results.mid?.sessions.find(s => s.id === 'worker')?.agentRun?.status,
    finalStatus: latest?.sessions.find(s => s.id === 'worker')?.agentRun?.status,
    finalText: latest?.sessions.find(s => s.id === 'worker')?.messages.filter(m => m.role === 'assistant' && !m.kind).at(-1)?.text };
});
console.log(JSON.stringify(result));
if (result.calls !== 2 || result.midStatus !== 'running' || result.finalStatus !== 'completed' || !result.finalText?.includes('Verified farewell')) throw new Error('Worker lifecycle regression');
await page.locator('textarea').fill('Verify every requested artifact before reporting completion. '.repeat(35));
await page.locator('.setup-trigger').click();
for (const viewport of [{ width: 1280, height: 840 }, { width: 1024, height: 700 }, { width: 800, height: 600 }]) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(300);
  const fits = await page.evaluate(() => {
    const panel = document.querySelector('.session-setup').getBoundingClientRect();
    const composer = document.querySelector('.composer-dock').getBoundingClientRect();
    return panel.top >= 0 && panel.bottom <= composer.top;
  });
  if (!fits) throw new Error(`Settings overlap at ${viewport.width}x${viewport.height}`);
}
await page.locator('.setup-close').click();
await page.getByRole('button', { name: 'New chat', exact: true }).click();
await page.locator('.setup-trigger').click();
const access = await page.locator('.session-setup').innerText();
if (!access.includes('Always allow · Full access')) throw new Error('New chat imported vendor access instead of desk access');
} finally {
  await browser.close();
}

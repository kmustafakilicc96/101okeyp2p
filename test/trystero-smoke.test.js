/**
 * test/trystero-smoke.test.js
 * Best-effort smoke test for TrysteroTransport (serverless CDN ES module + public relays).
 *
 * NOTE: Public Nostr/WebTorrent relays can be rate-limited, offline, or blocked by firewalls.
 * Per Section 7, this smoke test reports its result clearly and always exits 0 so flaky external
 * relays never fail the deterministic test suite.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GAME_URL = (process.env.GAME_URL || 'http://localhost:3000') + '/?transport=trystero';
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'okey101-trystero-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch (_) {}
}

(async () => {
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      wsUrl = v.webSocketDebuggerUrl;
      break;
    } catch (_) {
      await sleep(200);
    }
  }
  if (!wsUrl) {
    console.log('[Trystero Smoke] SKIP: Headless Chrome not reachable');
    cleanup();
    process.exit(0);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: GAME_URL, browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);

  const evalInPage = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    return r.result ? r.result.value : null;
  };

  await sleep(1500);
  const adapterExists = await evalInPage(`Boolean(window.OkeyTransport && window.OkeyTransport.TrysteroTransport)`);
  console.log(`[Trystero Smoke] Adapter registered: ${adapterExists}`);

  // Attempt to load pinned CDN module and create a room (10s timeout)
  const res = await evalInPage(`new Promise(async (resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout', note: 'CDN or public relay timed out' }), 8000);
    try {
      const t = new window.OkeyTransport.TrysteroTransport();
      t.onRoomReady((info) => {
        clearTimeout(timer);
        resolve({ status: 'ok', roomCode: info.roomCode, diag: t.getDiagnostics() });
      });
      t.onError((err) => {
        clearTimeout(timer);
        resolve({ status: 'unavailable', error: err });
      });
      await t.createRoom({ roomCode: 'SMK101' });
    } catch (e) {
      clearTimeout(timer);
      resolve({ status: 'error', error: e.message });
    }
  })`);

  console.log('[Trystero Smoke] Result:', JSON.stringify(res));
  cleanup();
  process.exit(0);
})().catch((e) => {
  console.log('[Trystero Smoke] Note (non-fatal):', e.message);
  cleanup();
  process.exit(0);
});


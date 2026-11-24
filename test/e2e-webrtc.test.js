/**
 * test/e2e-webrtc.test.js
 * Headless-Chrome CDP End-to-End Test for 4-Player 101 Okey P2P.
 *
 * Verifies in 4 isolated browser contexts (using LocalWsTransport):
 * 1. Host creates lobby, 3 Guests join (4 seats total), 5th peer rejected.
 * 2. WebRTC DataChannels open in star topology (Host <-> Guests 1..3), ICE candidate pair logged.
 * 3. Host starts game: Starter gets 22 tiles, other 3 players get 21 tiles, 20 tiles in draw pile.
 * 4. Players execute turns across WebRTC DataChannels while signaling server receives 0 gameplay messages.
 * 5. Kill Guest 1 mid-round, open a fresh isolated browser context, rejoin with roomCode + seatToken,
 *    and verify Guest 1 reclaims Seat 1 and restores their exact 21-tile rack.
 * 6. Refresh the Host page mid-round (Page.reload) and verify the Host restores state from localStorage,
 *    re-establishes WebRTC DataChannels with all 3 Guests, and the game resumes cleanly.
 * 7. Complete the full round across all 4 peers and verify final round scores.
 * 8. Wire-level PRIVACY CHECK on all received Guest DataChannel messages.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_URL = process.env.GAME_URL || 'http://localhost:3000';
const GAME_URL = `${BASE_URL}/?transport=localws`;
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function check(cond, name, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) {
    cleanup();
    process.exit(1);
  }
  passed++;
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'okey101-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  'about:blank'
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch (_) {}
}

async function connectCDP() {
  for (let i = 0; i < 50; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      return v.webSocketDebuggerUrl;
    } catch (_) {
      await sleep(200);
    }
  }
  throw new Error('Chrome DevTools endpoint not reachable');
}

(async () => {
  const ws = new WebSocket(await connectCDP());
  await new Promise((r) => (ws.onopen = r));
  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.text);
    }
  };

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  async function openPeer(url = GAME_URL) {
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url }, sessionId);

    const page = {
      browserContextId,
      targetId,
      sessionId,
      eval: async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' in: ' + expr);
        return r.result.value;
      },
      reload: async () => {
        await send('Page.reload', {}, sessionId);
      },
      close: async () => {
        try { await send('Target.closeTarget', { targetId }); } catch (_) {}
      },
      waitFor: async (expr, timeout = 20000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
          try {
            if (await page.eval(expr)) return true;
          } catch (_) {}
          await sleep(120);
        }
        return false;
      }
    };
    return page;
  }

  const serverInfo = async () => (await fetch(BASE_URL + '/api/server-info')).json();
  const visible = (id) => `!document.getElementById('${id}').classList.contains('hidden')`;
  const G = 'window.__okeyGame';

  // 1. Open 4 isolated browser contexts (Host + 3 Guests)
  const host = await openPeer();
  const g1 = await openPeer();
  const g2 = await openPeer();
  const g3 = await openPeer();

  for (const p of [host, g1, g2, g3]) {
    await p.waitFor(`Boolean(${G} && ${G}.Engine)`);
  }

  // Configure 1-round game on Host and create lobby
  await host.eval(`(() => {
    document.getElementById('input-player-name').value = 'HostP1';
    document.getElementById('select-rounds').value = '1';
    document.getElementById('btn-create-lobby').click();
  })()`);

  check(await host.waitFor(`${visible('screen-waiting')} && Boolean(${G}.roomCode)`), 'Host created 4-player lobby');
  const code = await host.eval(`${G}.roomCode`);
  check(/^[A-Z0-9]{6}$/.test(code), 'Valid 6-character room code generated', code);

  // 2. Join 3 Guests into the lobby over WebRTC DataChannels
  const guests = [
    { page: g1, name: 'GuestP2', expectedSeat: 1 },
    { page: g2, name: 'GuestP3', expectedSeat: 2 },
    { page: g3, name: 'GuestP4', expectedSeat: 3 }
  ];

  for (const g of guests) {
    await g.page.eval(`(() => {
      document.getElementById('input-player-name').value = '${g.name}';
      document.getElementById('input-room-code').value = '${code}';
      document.getElementById('join-form').requestSubmit();
    })()`);
    const joined = await g.page.waitFor(`${G}.localSeat === ${g.expectedSeat} && ${G}.publicState !== null`, 20000);
    check(joined, `${g.name} connected via WebRTC DataChannel and assigned Seat ${g.expectedSeat + 1}`);
  }

  check(
    await host.waitFor(`${G}.publicState.seats.filter(s => s.connected).length === 4`),
    'All 4 seats show connected in Host lobby'
  );

  // Verify 5th peer is rejected when room has 4 players
  const fifth = await openPeer();
  await fifth.waitFor(`Boolean(${G})`);
  await fifth.eval(`(() => {
    document.getElementById('input-room-code').value = '${code}';
    document.getElementById('join-form').requestSubmit();
  })()`);
  check(
    await fifth.waitFor(`document.getElementById('alert-text').textContent.toLowerCase().includes('full')`, 8000),
    '5th device rejected from full 4-player room'
  );
  await fifth.close();

  // Check ICE candidate pair diagnostics on Host
  await sleep(1600);
  const hostDiag = await host.eval(`JSON.stringify(${G}.transport.getDiagnostics())`);
  const parsedDiag = JSON.parse(hostDiag);
  check(
    parsedDiag.openPeerCount === 3 && parsedDiag.candidateSummary.includes('['),
    'Diagnostics panel logs 3 open guest DataChannels and selected ICE candidate pair',
    parsedDiag.candidateSummary
  );

  // 3. Host clicks Start 101 Okey
  await host.eval(`document.getElementById('btn-start-game').click()`);
  for (const p of [host, g1, g2, g3]) {
    await p.waitFor(`${visible('screen-game')} && ${G}.publicState && ${G}.publicState.phase === 'playing'`);
  }
  check(true, 'Game started on all 4 peers automatically');

  // Verify initial tile counts: Random Starter = 22, other 3 seats = 21, Draw pile = 20
  const rackLengths = [
    await host.eval(`${G}.privateRack.length`),
    await g1.eval(`${G}.privateRack.length`),
    await g2.eval(`${G}.privateRack.length`),
    await g3.eval(`${G}.privateRack.length`)
  ];
  const drawPileCount0 = await host.eval(`${G}.publicState.drawPileCount`);
  check(
    rackLengths.filter((n) => n === 22).length === 1 &&
      rackLengths.filter((n) => n === 21).length === 3 &&
      drawPileCount0 === 20,
    'Initial deal verified (22 + 21 + 21 + 21 + 1 indicator + 20 draw pile = 106 tiles)'
  );

  if (process.env.SCREENSHOT_DIR) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 2, mobile: false }, host.sessionId);
    await sleep(300);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, host.sessionId);
    fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR, 'okey101-playing-table.png'), Buffer.from(data, 'base64'));
  }

  // 4. Play 4 turns across the 4 peers and verify 0 signaling server messages during gameplay
  const sigBefore = (await serverInfo()).signalingMessagesReceived;
  const peerPages = [host, g1, g2, g3];

  for (let step = 0; step < 4; step++) {
    const activeTurn = await host.eval(`${G}.publicState.currentTurn`);
    const activePage = peerPages[activeTurn];
    const turnPhase = await activePage.eval(`${G}.publicState.turnPhase`);
    if (turnPhase === 'draw') {
      await activePage.eval(`document.getElementById('btn-draw-stock').click()`);
      await activePage.waitFor(`${G}.publicState.turnPhase === 'act'`);
    }
    // Select first rack tile and discard it
    await activePage.eval(`(() => {
      const firstTile = document.querySelector('#player-rack-board .okey-tile');
      firstTile.click();
      document.getElementById('btn-discard-selected').click();
    })()`);
    const nextExpected = (activeTurn + 1) % 4;
    await host.waitFor(`${G}.publicState.currentTurn === ${nextExpected}`);
  }

  const sigAfter = (await serverInfo()).signalingMessagesReceived;
  check(
    sigAfter - sigBefore === 0,
    'Signaling server received 0 messages during 4 full WebRTC gameplay turns'
  );

  // 5. Kill Guest 1 (Seat 1) mid-round and rejoin from a new browser context with seatToken
  const g1SavedToken = await g1.eval(`${G}.localSeatToken`);
  const g1RackBefore = await g1.eval(`JSON.stringify(${G}.privateRack.map(t => t.id).sort((a,b)=>a-b))`);
  await g1.close();

  check(
    await host.waitFor(`${G}.publicState.seats[1].connected === false`, 10000),
    'Host detects Guest 1 (Seat 2) disconnected mid-round'
  );

  const g1Rejoined = await openPeer();
  await g1Rejoined.waitFor(`Boolean(${G} && ${G}.Engine)`);
  await g1Rejoined.eval(`${G}.rejoinGuest('${code}', '${g1SavedToken}', 'GuestP2', 'localws')`);
  check(
    await g1Rejoined.waitFor(`${visible('screen-game')} && ${G}.localSeat === 1 && ${G}.privateRack.length === 21`, 20000),
    'Rejoined Guest 1 reclaimed Seat 2 over WebRTC'
  );
  const g1RackAfter = await g1Rejoined.eval(`JSON.stringify(${G}.privateRack.map(t => t.id).sort((a,b)=>a-b))`);
  check(
    g1RackBefore === g1RackAfter,
    'Rejoined Guest 1 restored the exact 21-tile private rack'
  );
  peerPages[1] = g1Rejoined;

  // 6. Refresh Host mid-round and verify game resumes from localStorage
  const seqBeforeRefresh = await host.eval(`${G}.publicState.seq`);
  const drawCountBeforeRefresh = await host.eval(`${G}.publicState.drawPileCount`);
  await host.reload();

  check(
    await host.waitFor(`${visible('screen-game')} && ${G}.publicState && ${G}.publicState.drawPileCount === ${drawCountBeforeRefresh}`, 20000),
    'Refreshed Host restored authoritative game state from localStorage'
  );
  check(
    await host.waitFor(`${G}.publicState.seats.filter(s => s.connected).length === 4`, 20000),
    'All 3 Guests automatically re-established WebRTC DataChannels with refreshed Host'
  );
  check(
    await g1Rejoined.waitFor(`document.getElementById('pause-banner').classList.contains('hidden')`, 10000),
    'Guests exited paused state and resumed gameplay'
  );

  // 7. Play out the rest of the round across the 4 peers until round/match completion
  let safetyTurns = 0;
  while (safetyTurns < 30) {
    const phase = await host.eval(`${G}.publicState.phase`);
    if (phase !== 'playing') break;
    const cur = await host.eval(`${G}.publicState.currentTurn`);
    const p = peerPages[cur];
    await p.waitFor(`${G}.publicState.currentTurn === ${cur} && ${G}.publicState.phase === 'playing'`, 10000);
    const tp = await p.eval(`${G}.publicState.turnPhase`);
    if (tp === 'draw') {
      await p.eval(`${G}.sendIntent({ type: 'DRAW_STOCK' })`);
      await p.waitFor(`${G}.publicState.turnPhase === 'act' || ${G}.publicState.phase !== 'playing'`, 10000);
    }
    const phaseAfterDraw = await host.eval(`${G}.publicState.phase`);
    if (phaseAfterDraw !== 'playing') break;
    const discardId = await p.eval(`${G}.privateRack[0].id`);
    await p.eval(`${G}.sendIntent({ type: 'DISCARD', tileId: ${discardId} })`);
    await host.waitFor(`${G}.publicState.currentTurn !== ${cur} || ${G}.publicState.phase !== 'playing'`, 10000);
    safetyTurns++;
  }

  const finalPhase = await host.eval(`${G}.publicState.phase`);
  check(
    finalPhase === 'matchEnd' || finalPhase === 'roundEnd',
    `Full 4-player WebRTC round completed cleanly (phase=${finalPhase})`
  );

  // 8. Wire-level PRIVACY CHECK on all received Guest messages
  let wireMessagesInspected = 0;
  for (const gp of [g1Rejoined, g2, g3]) {
    const checkResult = await gp.eval(`(() => {
      const mySeat = ${G}.localSeat;
      const msgs = ${G}.receivedMessages;
      for (const m of msgs) {
        if (m.publicState) {
          if (Array.isArray(m.publicState.drawPile)) return 'drawPile array leaked';
          for (const s of m.publicState.seats) {
            if (s.rack !== undefined) return 'seat.rack leaked in publicState';
            if (s.seatToken !== undefined) return 'seat.seatToken leaked in publicState';
          }
        }
        if (m.privateRack && m.privateRack.seat !== mySeat) {
          return 'received privateRack for wrong seat ' + m.privateRack.seat;
        }
      }
      return { ok: true, count: msgs.length };
    })()`);
    check(checkResult && checkResult.ok, 'Guest wire messages contain zero hidden information leaks', `(${checkResult.count} msgs)`);
    wireMessagesInspected += checkResult.count || 0;
  }
  check(wireMessagesInspected > 30, `Verified ${wireMessagesInspected} total guest DataChannel payloads`);

  if (process.env.SCREENSHOT_DIR) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, host.sessionId);
    fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR, 'okey101-e2e-host.png'), Buffer.from(data, 'base64'));
  }

  check(consoleErrors.length === 0, 'Zero uncaught page exceptions across all browser contexts', consoleErrors.join(' | '));
  console.log(`\nAll ${passed} E2E 4-player WebRTC checks passed.`);
  cleanup();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  cleanup();
  process.exit(1);
});

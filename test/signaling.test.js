/**
 * test/signaling.test.js
 * Automated checks for the 4-player signaling server's lobby rules (uses Node's built-in WebSocket, Node >= 22).
 * Run with the server already started:  node test/signaling.test.js
 */
const URL_WS = process.env.WS_URL || 'ws://localhost:3000/signal';

function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_WS);
    const queue = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else queue.push(msg);
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      next: (type, timeout = 2000) => new Promise((res, rej) => {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) return res(queue.splice(i, 1)[0]);
        const t = setTimeout(() => rej(new Error('timeout waiting for ' + type)), timeout);
        waiters.push({ type, resolve: (m) => { clearTimeout(t); res(m); } });
      }),
      close: () => ws.close()
    });
  });
}

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('FAIL:', name); process.exit(1); }
  passed++;
  console.log('PASS:', name);
}

(async () => {
  const host = await client();
  await host.next('welcome');
  host.send({ type: 'create-room' });
  const created = await host.next('room-created');
  ok(/^[A-Z2-9]{6}$/.test(created.roomCode) && created.playerId === 'P1', 'host creates 4-player room with 6-char code ' + created.roomCode);

  const extra = await client();
  await extra.next('welcome');
  extra.send({ type: 'join-room', roomCode: 'ZZZZZZ' });
  const rej = await extra.next('join-rejected');
  ok(/does not exist/.test(rej.reason), 'invalid room code rejected');

  // Join 3 guests (seats P2, P3, P4)
  const g1 = await client();
  await g1.next('welcome');
  g1.send({ type: 'join-room', roomCode: created.roomCode.toLowerCase() });
  const j1 = await g1.next('room-joined');
  const pj1 = await host.next('peer-joined');
  ok(j1.playerId === 'P2' && pj1.peerId === j1.peerId, 'guest 1 joins (case-insensitive) as P2');

  const g2 = await client();
  await g2.next('welcome');
  g2.send({ type: 'join-room', roomCode: created.roomCode });
  const j2 = await g2.next('room-joined');
  const pj2 = await host.next('peer-joined');
  ok(j2.playerId === 'P3' && pj2.peerId === j2.peerId, 'guest 2 joins as P3');

  const g3 = await client();
  await g3.next('welcome');
  g3.send({ type: 'join-room', roomCode: created.roomCode });
  const j3 = await g3.next('room-joined');
  const pj3 = await host.next('peer-joined');
  ok(j3.playerId === 'P4' && pj3.peerId === j3.peerId, 'guest 3 joins as P4 (4 seats filled)');

  // 5th player rejected
  extra.send({ type: 'join-room', roomCode: created.roomCode });
  const full = await extra.next('join-rejected');
  ok(/full/.test(full.reason), 'fifth player rejected (4 players max)');

  // Targeted offer relay from host -> guest 2
  host.send({ type: 'offer', targetPeerId: j2.peerId, sdp: { type: 'offer', sdp: 'v=0 target-g2' } });
  const fwd = await g2.next('offer');
  ok(fwd.sdp.sdp === 'v=0 target-g2', 'targeted offer relayed host -> guest 2');

  // ICE candidate relay from guest 2 -> host
  g2.send({ type: 'ice-candidate', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' } });
  const ice = await host.next('ice-candidate');
  ok(ice.candidate.candidate.includes('typ host') && ice.fromPeerId === j2.peerId, 'ICE candidate relayed guest 2 -> host with fromPeerId');

  // Gameplay messages strictly forbidden on signaling server
  host.send({ type: 'STATE_SYNC', rack: [1, 2, 3] });
  const forb = await host.next('error');
  ok(/Forbidden/.test(forb.message), 'gameplay message types refused by signaling server');
  let leaked = false;
  try { await g1.next('STATE_SYNC', 300); leaked = true; } catch (_) {}
  ok(!leaked, 'gameplay message NOT forwarded to guests');

  // Guest leave notification
  g1.close();
  const left = await host.next('peer-left');
  ok(left.peerId === j1.peerId, 'host notified when a guest disconnects');

  // Host leave dissolves room
  host.send({ type: 'leave-room' });
  await host.next('left-room');
  extra.send({ type: 'join-room', roomCode: created.roomCode });
  const gone = await extra.next('join-rejected');
  ok(/does not exist/.test(gone.reason), 'closed room no longer joinable');

  host.close(); g2.close(); g3.close(); extra.close();
  console.log(`\nAll ${passed} signaling checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

/**
 * server.js
 * Static file server + zero-dependency RFC 6455 WebSocket SIGNALING server for 4-Player 101 Okey P2P.
 *
 * CRITICAL ARCHITECTURE CONSTRAINT:
 * This server ONLY handles 4-seat room matchmaking and WebRTC signaling (offer / answer / ice-candidate).
 * It never receives, processes, relays, or stores gameplay state, tile racks, or player moves.
 * All gameplay traffic flows peer-to-peer over WebRTC DataChannels.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS_PER_ROOM = 4; // 1 Host + up to 3 Guests

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const STATIC_FILES = new Set([
  '/index.html',
  '/style.css',
  '/engine.js',
  '/strings.js',
  '/transport.js',
  '/network.js',
  '/game.js',
  '/RULES.md'
]);

/**
 * roomCode -> {
 *   code: string,
 *   hostToken: string,
 *   createdAt: number,
 *   host: Client | null,
 *   hostGraceTimer: Timeout | null,
 *   guests: Map<string, Client> // peerId -> Client
 * }
 */
const rooms = new Map();

// Unambiguous characters only (no 0/O, 1/I/L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateRoomCode() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to generate unique room code');
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address });
    }
  }
  return out;
}

function normalizeIp(raw) {
  if (!raw) return '';
  const cleaned = String(raw).split(',')[0].trim();
  return cleaned.startsWith('::ffff:') ? cleaned.slice(7) : cleaned;
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function isPrivateIPv4(ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const parts = ip.split('.').map(Number);
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254)
  );
}

function resolvePeerLanInfo(clientA, clientB) {
  if (!clientA || !clientB || clientA.isTunneled || clientB.isTunneled) {
    return { sameLan: false, ipA: null, ipB: null };
  }
  const primaryLan = (lanAddresses()[0] && lanAddresses()[0].address) || '127.0.0.1';
  const ipA = isLoopbackIp(clientA.remoteIp)
    ? (isPrivateIPv4(clientB.localIp) && !isLoopbackIp(clientB.localIp) ? clientB.localIp : primaryLan)
    : clientA.remoteIp;
  const ipB = isLoopbackIp(clientB.remoteIp)
    ? (isPrivateIPv4(clientA.localIp) && !isLoopbackIp(clientA.localIp) ? clientA.localIp : primaryLan)
    : clientB.remoteIp;

  const sameLan = Boolean(ipA && ipB && isPrivateIPv4(ipA) && isPrivateIPv4(ipB));
  return { sameLan, ipA: sameLan ? ipA : null, ipB: sameLan ? ipB : null };
}

function expandMdnsCandidate(candidateObj, senderLanIp) {
  if (!candidateObj || typeof candidateObj.candidate !== 'string' || !senderLanIp) {
    return null;
  }
  const str = candidateObj.candidate;
  if (!/\b[0-9a-fA-F-]{16,}\.local\b/.test(str)) {
    return null;
  }
  const replaced = str.replace(/\b[0-9a-fA-F-]{16,}\.local\b/, senderLanIp);
  return Object.assign({}, candidateObj, { candidate: replaced });
}

// ---------------------------------------------------------------------------- HTTP
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;

  if (pathname === '/api/server-info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      port: PORT,
      lanAddresses: lanAddresses(),
      activeRooms: rooms.size,
      signalingMessagesReceived: signalingMessageCount
    }));
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  if (!STATIC_FILES.has(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }
  fs.readFile(path.join(__dirname, pathname), (err, data) => {
    if (err) { res.writeHead(500); res.end('500'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(pathname)], 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------- Minimal WebSocket (RFC 6455)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 64 * 1024;

class Client {
  constructor(socket, req) {
    this.socket = socket;
    this.id = crypto.randomBytes(4).toString('hex');
    this.remoteIp = normalizeIp(socket.remoteAddress);
    this.localIp = normalizeIp(socket.localAddress);
    this.isTunneled = Boolean(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']);
    this.resolvedLanIp = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    this.roomCode = null;
    this.role = null; // 'host' | 'guest'
    this.reservedFullSlot = true;
    this.lastSeen = Date.now();
    socket.setNoDelay(true);
    socket.on('data', (c) => this._onData(c));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  send(obj) {
    if (this.closed || !this.socket.writable) return;
    try { this.socket.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); } catch (_) { this._onClose(); }
  }

  ping() {
    if (!this.closed && this.socket.writable) this.socket.write(frame(0x9, Buffer.alloc(0)));
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (!masked) { this._onClose(); return; }
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) { this._onClose(); return; }
        len = Number(big); off = 10;
      }
      if (len > MAX_MESSAGE_BYTES) { this._onClose(); return; }
      if (this.buffer.length < off + 4 + len) return;
      const mask = this.buffer.subarray(off, off + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = this.buffer[off + 4 + i] ^ mask[i & 3];
      this.buffer = this.buffer.subarray(off + 4 + len);

      if (opcode === 0x8) { this._onClose(); return; }
      if (opcode === 0x9) { this.socket.write(frame(0xA, payload)); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          handleMessage(this, text);
        }
      }
    }
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    handleSocketDisconnect(this);
    try { this.socket.end(frame(0x8, Buffer.alloc(0))); } catch (_) {}
    try { this.socket.destroy(); } catch (_) {}
  }
}

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

const clients = new Set();

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const client = new Client(socket, req);
  clients.add(client);
  socket.on('close', () => clients.delete(client));
  client.send({ type: 'welcome', clientId: client.id });
});

// ---------------------------------------------------------------------------- Signaling logic ONLY
const ALLOWED = new Set([
  'create-room',
  'join-room',
  'leave-room',
  'offer',
  'answer',
  'ice-candidate',
  'ws-keepalive'
]);

let signalingMessageCount = 0;

function handleMessage(client, text) {
  signalingMessageCount++;
  let msg;
  try { msg = JSON.parse(text); } catch (_) { return client.send({ type: 'error', message: 'Malformed JSON.' }); }
  if (!msg || typeof msg.type !== 'string') return client.send({ type: 'error', message: 'Missing type.' });

  if (!ALLOWED.has(msg.type)) {
    return client.send({
      type: 'error',
      message: `Forbidden message type "${msg.type}". The signaling server does not carry gameplay data; use the WebRTC DataChannel.`
    });
  }

  switch (msg.type) {
    case 'ws-keepalive':
      client.send({ type: 'ws-keepalive-ack' });
      break;

    case 'create-room': {
      const requestedCode = msg.roomCode ? String(msg.roomCode).trim().toUpperCase() : null;
      const requestedToken = msg.hostToken ? String(msg.hostToken) : null;
      const maxGuests = typeof msg.maxGuests === 'number' ? Math.min(Math.max(msg.maxGuests, 1), 3) : 3;

      // Check if host is reclaiming an existing room after a browser refresh
      if (requestedCode && rooms.has(requestedCode)) {
        const existing = rooms.get(requestedCode);
        if (!existing.host || existing.host.closed || existing.hostToken === requestedToken) {
          if (existing.hostGraceTimer) {
            clearTimeout(existing.hostGraceTimer);
            existing.hostGraceTimer = null;
          }
          existing.host = client;
          if (requestedToken) existing.hostToken = requestedToken;
          client.roomCode = requestedCode;
          client.role = 'host';
          log(`room ${requestedCode} reclaimed by refreshed host ${client.id}`);
          client.send({
            type: 'room-created',
            roomCode: requestedCode,
            playerId: 'P1',
            peerId: client.id,
            hostToken: existing.hostToken,
            reclaimed: true
          });
          // Re-trigger WebRTC handshake with any guests waiting in the room
          for (const [guestId, guest] of existing.guests.entries()) {
            if (guest.closed) {
              existing.guests.delete(guestId);
              continue;
            }
            const lanInfo = resolvePeerLanInfo(client, guest);
            client.resolvedLanIp = lanInfo.ipA;
            guest.resolvedLanIp = lanInfo.ipB;
            guest.send({
              type: 'host-reconnected',
              roomCode: requestedCode,
              hostId: client.id,
              sameLan: lanInfo.sameLan,
              selfLanIp: lanInfo.ipB,
              peerLanIp: lanInfo.ipA
            });
            client.send({
              type: 'peer-joined',
              roomCode: requestedCode,
              peerId: guest.id,
              sameLan: lanInfo.sameLan,
              selfLanIp: lanInfo.ipA,
              peerLanIp: lanInfo.ipB
            });
          }
          break;
        }
      }

      explicitLeaveRoom(client, 'The host left the lobby.');
      const code = (requestedCode && /^[A-Z0-9]{6}$/.test(requestedCode) && !rooms.has(requestedCode))
        ? requestedCode
        : generateRoomCode();
      const hostToken = requestedToken || crypto.randomBytes(8).toString('hex');
      rooms.set(code, {
        code,
        hostToken,
        maxGuests,
        createdAt: Date.now(),
        host: client,
        hostGraceTimer: null,
        guests: new Map()
      });
      client.roomCode = code;
      client.role = 'host';
      log(`room ${code} created by ${client.id} (${client.remoteIp})`);
      client.send({
        type: 'room-created',
        roomCode: code,
        playerId: 'P1',
        peerId: client.id,
        hostToken
      });
      break;
    }

    case 'join-room': {
      const code = String(msg.roomCode || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) {
        return client.send({ type: 'join-rejected', reason: 'Room codes are 6 characters long.' });
      }
      const room = rooms.get(code);
      if (!room || (!room.host && !room.hostGraceTimer)) {
        return client.send({ type: 'join-rejected', reason: `Room "${code}" does not exist or has expired.` });
      }
      if (room.host === client) {
        return client.send({ type: 'join-rejected', reason: 'You are the host of this room. Join from another device.' });
      }

      // Prune closed guests
      for (const [gid, g] of room.guests.entries()) {
        if (g.closed) room.guests.delete(gid);
      }

      const isRejoinAttempt = Boolean(msg.rejoinToken);
      const maxGuests = room.maxGuests || (MAX_PLAYERS_PER_ROOM - 1);
      if (room.guests.size >= maxGuests && !room.guests.has(client.id) && !isRejoinAttempt) {
        return client.send({
          type: 'join-rejected',
          reason: `Room "${code}" is full (${maxGuests + 1} players max).`
        });
      }

      if (client.roomCode && client.roomCode !== code) {
        explicitLeaveRoom(client, 'Player switched rooms.');
      }

      room.guests.set(client.id, client);
      client.roomCode = code;
      client.role = 'guest';

      const guestIndex = room.guests.size; // 1..3
      const playerId = `P${guestIndex + 1}`;
      const lanInfo = room.host ? resolvePeerLanInfo(room.host, client) : { sameLan: false, ipA: null, ipB: null };
      if (room.host) room.host.resolvedLanIp = lanInfo.ipA;
      client.resolvedLanIp = lanInfo.ipB;

      log(`${client.id} (${client.remoteIp}) joined room ${code} as ${playerId} (${room.guests.size}/${maxGuests} guests)`);
      client.send({
        type: 'room-joined',
        roomCode: code,
        playerId,
        peerId: client.id,
        hostId: room.host ? room.host.id : null,
        sameLan: lanInfo.sameLan,
        selfLanIp: lanInfo.ipB,
        peerLanIp: lanInfo.ipA
      });

      if (room.host && !room.host.closed) {
        room.host.send({
          type: 'peer-joined',
          roomCode: code,
          peerId: client.id,
          playerId,
          sameLan: lanInfo.sameLan,
          selfLanIp: lanInfo.ipA,
          peerLanIp: lanInfo.ipB
        });
      }
      break;
    }

    case 'offer':
    case 'answer':
    case 'ice-candidate': {
      const room = client.roomCode && rooms.get(client.roomCode);
      if (!room) return client.send({ type: 'error', message: 'Not in a room.' });

      let target = null;
      if (client === room.host) {
        if (msg.targetPeerId && room.guests.has(msg.targetPeerId)) {
          target = room.guests.get(msg.targetPeerId);
        } else {
          // Default to first guest (2-player backwards compatibility)
          const firstGuest = room.guests.values().next().value;
          target = firstGuest || null;
        }
      } else {
        target = room.host;
      }

      if (!target || target.closed) {
        return client.send({ type: 'error', message: 'Peer not present.' });
      }

      if (msg.type === 'ice-candidate') {
        const expanded = expandMdnsCandidate(msg.candidate, client.resolvedLanIp);
        if (expanded) {
          target.send({
            type: 'ice-candidate',
            fromPeerId: client.id,
            sdp: null,
            candidate: expanded
          });
        }
      }

      target.send({
        type: msg.type,
        fromPeerId: client.id,
        sdp: msg.sdp || null,
        candidate: msg.candidate || null
      });
      break;
    }

    case 'leave-room':
      explicitLeaveRoom(client, 'The other player left the lobby.', Boolean(msg.holdRoom));
      client.send({ type: 'left-room' });
      break;
  }
}

function handleSocketDisconnect(client) {
  const code = client.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  // If the host socket closes unexpectedly (e.g. page refresh) while guests are present,
  // hold the room for 15 seconds so the host can reclaim it on reload.
  // If no guests are left or only 1 guest in a 2-player signaling test, notify peer-left immediately
  // AND keep the room reclaimable for 15 seconds if hostToken is presented.
  if (room.host === client) {
    room.host = null;
    for (const guest of room.guests.values()) {
      if (!guest.closed) {
        guest.send({
          type: 'host-disconnected',
          roomCode: code,
          reason: 'The host disconnected.'
        });
      }
    }
    if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = setTimeout(() => {
      const r = rooms.get(code);
      if (r && !r.host) {
        for (const g of r.guests.values()) {
          g.roomCode = null;
          g.role = null;
          if (!g.closed) g.send({ type: 'peer-left', reason: 'Host left the game.' });
        }
        rooms.delete(code);
        log(`room ${code} closed (host grace expired)`);
      }
    }, 15000);
    if (room.hostGraceTimer.unref) room.hostGraceTimer.unref();
    return;
  }

  explicitLeaveRoom(client, 'A player disconnected from the signaling server.');
}

function explicitLeaveRoom(client, reason) {
  const code = client.roomCode;
  client.roomCode = null;
  client.role = null;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  if (room.host === client) {
    if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
    rooms.delete(code);
    for (const guest of room.guests.values()) {
      guest.roomCode = null;
      guest.role = null;
      if (!guest.closed) {
        guest.send({ type: 'peer-left', peerId: client.id, isHost: true, reason });
      }
    }
    log(`room ${code} closed (host ${client.id} left)`);
  } else if (room.guests.has(client.id)) {
    room.guests.delete(client.id);
    if (room.host && !room.host.closed) {
      room.host.send({ type: 'peer-left', peerId: client.id, isHost: false, reason });
    }
    // If no guests remain and host is gone, delete the room
    if (room.guests.size === 0 && (!room.host || room.host.closed)) {
      if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
      rooms.delete(code);
    }
    log(`guest ${client.id} left room ${code} (${room.guests.size} guests remaining)`);
  }
}

// Abandoned-room cleanup + dead socket detection
const WAITING_ROOM_TTL_MS = 30 * 60 * 1000;
const SOCKET_IDLE_MS = 90 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    if (now - c.lastSeen > SOCKET_IDLE_MS) c._onClose();
    else c.ping();
  }
  for (const [code, room] of rooms) {
    const hostDead = (!room.host || room.host.closed) && !room.hostGraceTimer;
    const waitingExpired = room.guests.size === 0 && (now - room.createdAt > WAITING_ROOM_TTL_MS);
    if (hostDead || waitingExpired) {
      if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
      rooms.delete(code);
      if (room.host && !room.host.closed) {
        room.host.roomCode = null;
        room.host.send({ type: 'peer-left', reason: 'Lobby expired due to inactivity.' });
      }
      log(`room ${code} cleaned up (abandoned)`);
    }
  }
}, 30 * 1000).unref();

function log(s) { console.log(`[signaling ${new Date().toISOString().slice(11, 19)}] ${s}`); }

server.listen(PORT, HOST, () => {
  console.log('==========================================================');
  console.log(' 101 Okey P2P - 4-Player Signaling + Static Server');
  console.log('==========================================================');
  console.log(` Local:  http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(` LAN:    http://${a.address}:${PORT}   (${a.name})`);
  console.log(' Gameplay data flows over WebRTC DataChannels, never here.');
  console.log('==========================================================');
});

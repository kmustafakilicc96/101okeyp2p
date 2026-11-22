/**
 * transport.js
 * Unified WebRTC P2P Transport Layer for 4-Player 101 Okey.
 *
 * Implements a common interface with two adapters:
 *   1. TrysteroTransport (default for static hosting / cross-network production):
 *      Uses pinned Trystero v0.20.1 ES module from CDN with public relays for discovery only,
 *      then sends all gameplay messages over WebRTC DataChannels.
 *   2. LocalWsTransport (LAN & automated headless-Chrome CDP tests):
 *      Uses server.js WebSocket signaling to establish a 4-peer star topology of reliable,
 *      ordered WebRTC RTCDataChannels (Host <-> Guest 1..3).
 *
 * CRITICAL CONSTRAINT:
 * Gameplay messages travel ONLY over WebRTC DataChannels in both adapters.
 * Never silently falls back to server-relayed gameplay.
 */
(function (root) {
  'use strict';

  const DEFAULT_ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  // Pinned Trystero CDN ES module URLs (v0.20.1)
  const TRYSTERO_CDN_URLS = [
    'https://esm.sh/trystero@0.20.1/nostr',
    'https://cdn.jsdelivr.net/npm/trystero@0.20.1/nostr/+esm',
    'https://esm.sh/trystero@0.20.1/torrent'
  ];

  const TRYSTERO_APP_ID = 'okey101-p2p-v1';
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function generateLocalRoomCode() {
    let code = '';
    const arr = new Uint8Array(6);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < 6; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
    }
    return code;
  }

  function buildIceServers(customTurn, sameLan) {
    if (sameLan && !customTurn) {
      return [];
    }
    const list = DEFAULT_ICE_SERVERS.slice();
    if (customTurn && customTurn.urls) {
      list.push(customTurn);
    }
    return list;
  }

  function shouldIgnoreCandidate(candidateStr, sameLan) {
    if (!candidateStr || typeof candidateStr !== 'string') return false;
    const parts = candidateStr.trim().split(/\s+/);
    const addr = (parts[4] || '').toLowerCase();
    const typIndex = parts.indexOf('typ');
    const candType = typIndex >= 0 ? (parts[typIndex + 1] || '').toLowerCase() : '';
    if (addr.startsWith('fe80:')) return true;
    if (addr.startsWith('169.254.')) return true;
    if (sameLan && candType === 'srflx') return true;
    return false;
  }

  async function inspectPeerConnectionStats(pc) {
    if (!pc || typeof pc.getStats !== 'function') return null;
    try {
      const report = await pc.getStats();
      let pair = null;
      let transport = null;
      report.forEach((r) => { if (r.type === 'transport') transport = r; });
      if (transport && transport.selectedCandidatePairId) {
        pair = report.get(transport.selectedCandidatePairId);
      }
      if (!pair) {
        report.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) {
            pair = r;
          }
        });
      }
      if (!pair) return null;
      const local = report.get(pair.localCandidateId);
      const remote = report.get(pair.remoteCandidateId);
      const lt = (local && (local.candidateType || local.type)) || 'unknown';
      const rt = (remote && (remote.candidateType || remote.type)) || 'unknown';
      const proto = (local && local.protocol) || 'udp';
      let connectionType = 'Direct P2P (STUN/NAT)';
      if (lt === 'relay' || rt === 'relay') {
        connectionType = 'TURN relay (WebRTC)';
      } else if (lt === 'host' && rt === 'host') {
        connectionType = 'Direct P2P (LAN host)';
      }
      const rttMs = typeof pair.currentRoundTripTime === 'number'
        ? pair.currentRoundTripTime * 1000
        : null;
      return {
        connectionType,
        localCandidateType: lt,
        remoteCandidateType: rt,
        protocol: proto,
        candidateSummary: `${connectionType} [${lt}↔${rt}, ${proto}]`,
        rttMs
      };
    } catch (_) {
      return null;
    }
  }

  // ===========================================================================
  // Adapter 1: LocalWsTransport (4-Peer Host-Authoritative Star via server.js)
  // ===========================================================================
  class LocalWsTransport {
    constructor(options) {
      const opts = options || {};
      this.adapterName = 'LocalWsTransport';
      this.customTurn = opts.turnConfig || null;
      this.ws = null;
      this.wsReady = false;
      this.wsReconnectTimer = null;
      this.wsKeepaliveTimer = null;
      this._signalChain = Promise.resolve();

      this.role = null;       // 'host' | 'guest'
      this.roomCode = null;
      this.hostToken = null;
      this.rejoinToken = null;
      this.selfPeerId = null;
      this.hostPeerId = null;
      this.closed = false;

      // Map of peerId -> { pc, dc, pendingCandidates, sameLan, rttMs, pcState, iceState, dcState, candidateSummary }
      this.peers = new Map();

      this.txMessages = 0;
      this.rxMessages = 0;
      this.signalingState = 'connecting';

      this._cbPeerJoin = null;
      this._cbPeerLeave = null;
      this._cbMessage = null;
      this._cbRoomReady = null;
      this._cbError = null;
      this._cbDiag = null;
      this._cbHostStatus = null;

      this.pingTimer = null;
      this.statsTimer = null;
    }

    onPeerJoin(cb) { this._cbPeerJoin = cb; }
    onPeerLeave(cb) { this._cbPeerLeave = cb; }
    onMessage(cb) { this._cbMessage = cb; }
    onRoomReady(cb) { this._cbRoomReady = cb; }
    onError(cb) { this._cbError = cb; }
    onDiag(cb) { this._cbDiag = cb; }
    onHostStatus(cb) { this._cbHostStatus = cb; }

    setTurnConfig(turn) {
      this.customTurn = turn && turn.urls ? turn : null;
    }

    connectSignaling() {
      if (this.closed) return Promise.resolve(false);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${location.host}/signal`;
        this.signalingState = 'connecting';
        this._emitDiag();

        let resolved = false;
        const done = (ok) => {
          if (!resolved) {
            resolved = true;
            resolve(ok);
          }
        };

        let ws;
        try {
          ws = new WebSocket(url);
        } catch (e) {
          this.signalingState = 'offline';
          this._emitDiag();
          done(false);
          return;
        }
        this.ws = ws;

        ws.onopen = () => {
          this.wsReady = true;
          this.signalingState = 'connected';
          this._emitDiag();
          clearInterval(this.wsKeepaliveTimer);
          this.wsKeepaliveTimer = setInterval(() => this._sendSignal({ type: 'ws-keepalive' }), 25000);
          done(true);
        };

        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (_) { return; }
          this._signalChain = this._signalChain
            .then(() => this._handleSignal(msg))
            .catch((err) => console.warn('[LocalWsTransport signal error]', err));
        };

        ws.onclose = () => {
          this.wsReady = false;
          clearInterval(this.wsKeepaliveTimer);
          this.signalingState = 'offline';
          this._emitDiag();
          done(false);
          if (!this.closed) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = setTimeout(() => this.connectSignaling(), 2000);
          }
        };

        ws.onerror = () => {};
      });
    }

    _sendSignal(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    }

    async createRoom(options) {
      const opts = options || {};
      this.closed = false;
      this.role = 'host';
      const ok = await this.connectSignaling();
      if (!ok) {
        if (this._cbError) this._cbError('Could not connect to local signaling server (server.js).');
        return;
      }
      this._startLoops();
      this._sendSignal({
        type: 'create-room',
        roomCode: opts.roomCode || null,
        hostToken: opts.hostToken || null,
        maxGuests: opts.maxGuests || 3
      });
    }

    async joinRoom(code, options) {
      const opts = options || {};
      this.closed = false;
      this.role = 'guest';
      this.rejoinToken = opts.rejoinToken || null;
      const ok = await this.connectSignaling();
      if (!ok) {
        if (this._cbError) this._cbError('Could not connect to local signaling server (server.js).');
        return;
      }
      this._startLoops();
      this._sendSignal({
        type: 'join-room',
        roomCode: String(code || '').trim().toUpperCase(),
        rejoinToken: this.rejoinToken
      });
    }

    async _handleSignal(msg) {
      switch (msg.type) {
        case 'welcome':
          this.selfPeerId = msg.clientId;
          break;

        case 'room-created':
          this.roomCode = msg.roomCode;
          this.selfPeerId = msg.peerId || this.selfPeerId;
          this.hostToken = msg.hostToken || this.hostToken;
          this._emitDiag();
          if (this._cbRoomReady) {
            this._cbRoomReady({
              roomCode: this.roomCode,
              role: 'host',
              selfPeerId: this.selfPeerId,
              hostToken: this.hostToken,
              reclaimed: Boolean(msg.reclaimed)
            });
          }
          break;

        case 'room-joined':
          this.roomCode = msg.roomCode;
          this.selfPeerId = msg.peerId || this.selfPeerId;
          this.hostPeerId = msg.hostId;
          this._emitDiag();
          if (this._cbRoomReady) {
            this._cbRoomReady({
              roomCode: this.roomCode,
              role: 'guest',
              selfPeerId: this.selfPeerId,
              hostPeerId: this.hostPeerId
            });
          }
          if (this.hostPeerId) {
            this._ensurePeerEntry(this.hostPeerId, false, Boolean(msg.sameLan));
          }
          break;

        case 'host-reconnected':
          this.hostPeerId = msg.hostId;
          // Clean up old host entries and prepare for new host offer
          for (const pid of Array.from(this.peers.keys())) {
            this._closePeerEntry(pid);
          }
          this._ensurePeerEntry(this.hostPeerId, false, Boolean(msg.sameLan));
          if (this._cbHostStatus) this._cbHostStatus('reconnecting');
          break;

        case 'host-disconnected':
          if (this._cbHostStatus) this._cbHostStatus('paused', msg.reason);
          break;

        case 'join-rejected':
          if (this._cbError) this._cbError(msg.reason || 'Join rejected.');
          break;

        case 'peer-joined': {
          // Host receives notification that a guest joined -> initiate WebRTC Offer to msg.peerId
          const guestPeerId = msg.peerId;
          const entry = this._ensurePeerEntry(guestPeerId, true, Boolean(msg.sameLan));
          try {
            const offer = await entry.pc.createOffer();
            await entry.pc.setLocalDescription(offer);
            this._sendSignal({
              type: 'offer',
              targetPeerId: guestPeerId,
              sdp: entry.pc.localDescription.toJSON()
            });
          } catch (e) {
            if (this._cbError) this._cbError('Failed to create WebRTC offer: ' + e.message);
          }
          break;
        }

        case 'offer': {
          const fromPeerId = msg.fromPeerId || this.hostPeerId || 'host';
          this.hostPeerId = fromPeerId;
          const entry = this._ensurePeerEntry(fromPeerId, false, false);
          try {
            await entry.pc.setRemoteDescription(msg.sdp);
            await this._flushCandidates(entry);
            const answer = await entry.pc.createAnswer();
            await entry.pc.setLocalDescription(answer);
            this._sendSignal({
              type: 'answer',
              targetPeerId: fromPeerId,
              sdp: entry.pc.localDescription.toJSON()
            });
          } catch (e) {
            if (this._cbError) this._cbError('Failed to handle WebRTC offer: ' + e.message);
          }
          break;
        }

        case 'answer': {
          const fromPeerId = msg.fromPeerId;
          const entry = this.peers.get(fromPeerId);
          if (!entry) return;
          try {
            await entry.pc.setRemoteDescription(msg.sdp);
            await this._flushCandidates(entry);
          } catch (e) {
            if (this._cbError) this._cbError('Failed to apply WebRTC answer: ' + e.message);
          }
          break;
        }

        case 'ice-candidate': {
          const fromPeerId = msg.fromPeerId || this.hostPeerId;
          const entry = this.peers.get(fromPeerId);
          if (!entry || !msg.candidate) return;
          if (shouldIgnoreCandidate(msg.candidate.candidate, entry.sameLan)) return;
          if (!entry.pc.remoteDescription || !entry.pc.remoteDescription.type) {
            entry.pendingCandidates.push(msg.candidate);
            return;
          }
          try {
            await entry.pc.addIceCandidate(msg.candidate);
          } catch (_) {}
          break;
        }

        case 'peer-left': {
          const pid = msg.peerId;
          if (pid && this.peers.has(pid)) {
            this._closePeerEntry(pid);
            if (this._cbPeerLeave) this._cbPeerLeave(pid, msg.reason);
          } else if (msg.isHost && this.role === 'guest') {
            if (this._cbHostStatus) this._cbHostStatus('closed', msg.reason);
            if (this._cbPeerLeave) this._cbPeerLeave(this.hostPeerId || 'host', msg.reason);
          }
          this._emitDiag();
          break;
        }
      }
    }

    _ensurePeerEntry(peerId, isInitiator, sameLan) {
      if (this.peers.has(peerId)) {
        const existing = this.peers.get(peerId);
        if (isInitiator) {
          this._closePeerEntry(peerId);
        } else {
          return existing;
        }
      }

      const pc = new RTCPeerConnection({
        iceServers: buildIceServers(this.customTurn, sameLan)
      });

      const entry = {
        peerId,
        pc,
        dc: null,
        sameLan: Boolean(sameLan),
        pendingCandidates: [],
        open: false,
        rttMs: null,
        pcState: 'new',
        iceState: 'new',
        dcState: 'connecting',
        connectionType: 'Connecting...',
        candidateSummary: 'Negotiating ICE...',
        connectTimer: null
      };

      this.peers.set(peerId, entry);

      if (isInitiator) {
        const dc = pc.createDataChannel('okey101', { ordered: true });
        entry.dc = dc;
        this._wireDataChannel(entry, dc);
      } else {
        pc.ondatachannel = (ev) => {
          entry.dc = ev.channel;
          this._wireDataChannel(entry, ev.channel);
        };
      }

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const json = ev.candidate.toJSON ? ev.candidate.toJSON() : {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex
        };
        if (shouldIgnoreCandidate(json.candidate, entry.sameLan)) return;
        this._sendSignal({
          type: 'ice-candidate',
          targetPeerId: peerId,
          candidate: json
        });
      };

      pc.oniceconnectionstatechange = () => {
        entry.iceState = pc.iceConnectionState;
        this._emitDiag();
      };

      pc.onconnectionstatechange = () => {
        entry.pcState = pc.connectionState;
        if (pc.connectionState === 'connected') {
          this._refreshEntryStats(entry);
        } else if (pc.connectionState === 'failed') {
          if (this._cbError) {
            this._cbError('WebRTC P2P connection failed. Configure a TURN server if behind symmetric NAT.');
          }
        }
        this._emitDiag();
      };

      entry.connectTimer = setTimeout(() => {
        if (!entry.open && this.peers.get(peerId) === entry) {
          if (this._cbError) {
            this._cbError('Timed out establishing WebRTC P2P DataChannel. A TURN server may be required.');
          }
        }
      }, 25000);

      return entry;
    }

    _wireDataChannel(entry, dc) {
      dc.onopen = () => {
        clearTimeout(entry.connectTimer);
        entry.open = true;
        entry.dcState = 'open';
        this._refreshEntryStats(entry);
        this._emitDiag();
        if (this._cbPeerJoin) this._cbPeerJoin(entry.peerId);
        if (this.role === 'guest' && this._cbHostStatus) {
          this._cbHostStatus('connected');
        }
      };

      dc.onclose = () => {
        const wasOpen = entry.open;
        entry.open = false;
        entry.dcState = 'closed';
        this._emitDiag();
        if (wasOpen && !this.closed) {
          if (this.role === 'guest' && this._cbHostStatus) {
            this._cbHostStatus('paused', 'DataChannel to host closed.');
          }
          if (this._cbPeerLeave) {
            this._cbPeerLeave(entry.peerId, 'Peer DataChannel closed.');
          }
        }
      };

      dc.onerror = (err) => console.warn('[DataChannel error]', entry.peerId, err);

      dc.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg && msg.__t === 'ping') {
          if (dc.readyState === 'open') {
            try { dc.send(JSON.stringify({ __t: 'pong', ts: msg.ts })); } catch (_) {}
          }
          return;
        }
        if (msg && msg.__t === 'pong') {
          if (typeof msg.ts === 'number') {
            const rtt = performance.now() - msg.ts;
            entry.rttMs = entry.rttMs == null ? rtt : entry.rttMs * 0.7 + rtt * 0.3;
            this._emitDiag();
          }
          return;
        }
        this.rxMessages++;
        this._emitDiag();
        if (this._cbMessage) this._cbMessage(entry.peerId, msg);
      };
    }

    async _flushCandidates(entry) {
      const list = entry.pendingCandidates;
      entry.pendingCandidates = [];
      for (const c of list) {
        if (shouldIgnoreCandidate(c.candidate, entry.sameLan)) continue;
        try { await entry.pc.addIceCandidate(c); } catch (_) {}
      }
    }

    send(peerId, msg) {
      const targetId = peerId || this.hostPeerId;
      const entry = this.peers.get(targetId);
      if (!entry || !entry.dc || entry.dc.readyState !== 'open') return false;
      try {
        entry.dc.send(JSON.stringify(msg));
        this.txMessages++;
        return true;
      } catch (_) {
        return false;
      }
    }

    broadcast(msg) {
      let sent = 0;
      for (const entry of this.peers.values()) {
        if (entry.dc && entry.dc.readyState === 'open') {
          try {
            entry.dc.send(JSON.stringify(msg));
            this.txMessages++;
            sent++;
          } catch (_) {}
        }
      }
      return sent;
    }

    _startLoops() {
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        const now = performance.now();
        for (const entry of this.peers.values()) {
          if (entry.dc && entry.dc.readyState === 'open') {
            try { entry.dc.send(JSON.stringify({ __t: 'ping', ts: now })); } catch (_) {}
          }
        }
      }, 1500);

      clearInterval(this.statsTimer);
      this.statsTimer = setInterval(() => {
        for (const entry of this.peers.values()) {
          this._refreshEntryStats(entry);
        }
      }, 1500);
    }

    async _refreshEntryStats(entry) {
      const info = await inspectPeerConnectionStats(entry.pc);
      if (info) {
        entry.connectionType = info.connectionType;
        entry.candidateSummary = info.candidateSummary;
        if (entry.rttMs == null && info.rttMs != null) {
          entry.rttMs = info.rttMs;
        }
        this._emitDiag();
      }
    }

    _emitDiag() {
      if (this._cbDiag) this._cbDiag(this.getDiagnostics());
    }

    getDiagnostics() {
      const openPeers = [];
      let sumRtt = 0;
      let rttCount = 0;
      let primarySummary = 'No active peer channel';
      let primaryConnType = 'Not connected';
      let pcState = 'idle';
      let dcState = 'closed';

      for (const entry of this.peers.values()) {
        pcState = entry.pcState;
        if (entry.open) {
          openPeers.push(entry.peerId);
          dcState = 'open (ordered, reliable)';
          primarySummary = entry.candidateSummary;
          primaryConnType = entry.connectionType;
          if (entry.rttMs != null) {
            sumRtt += entry.rttMs;
            rttCount++;
          }
        }
      }

      return {
        adapter: this.adapterName,
        signaling: this.signalingState,
        roomCode: this.roomCode,
        selfPeerId: this.selfPeerId,
        pcState: openPeers.length > 0 ? 'connected' : pcState,
        dcState,
        openPeerCount: openPeers.length,
        openPeers,
        rttMs: rttCount > 0 ? Math.round(sumRtt / rttCount) : null,
        txMessages: this.txMessages,
        rxMessages: this.rxMessages,
        connectionType: primaryConnType,
        candidateSummary: primarySummary
      };
    }

    _closePeerEntry(peerId) {
      const entry = this.peers.get(peerId);
      if (!entry) return;
      this.peers.delete(peerId);
      clearTimeout(entry.connectTimer);
      if (entry.dc) {
        entry.dc.onopen = entry.dc.onclose = entry.dc.onmessage = entry.dc.onerror = null;
        try { entry.dc.close(); } catch (_) {}
      }
      if (entry.pc) {
        entry.pc.ondatachannel = entry.pc.onicecandidate = entry.pc.onconnectionstatechange = entry.pc.oniceconnectionstatechange = null;
        try { entry.pc.close(); } catch (_) {}
      }
    }

    close(explicitLeave) {
      this.closed = true;
      clearInterval(this.pingTimer);
      clearInterval(this.statsTimer);
      clearTimeout(this.wsReconnectTimer);
      clearInterval(this.wsKeepaliveTimer);
      if (explicitLeave !== false) {
        this._sendSignal({ type: 'leave-room' });
      }
      for (const pid of Array.from(this.peers.keys())) {
        this._closePeerEntry(pid);
      }
      if (this.ws) {
        this.ws.onclose = null;
        try { this.ws.close(); } catch (_) {}
        this.ws = null;
      }
    }
  }

  // ===========================================================================
  // Adapter 2: TrysteroTransport (Serverless WebRTC via Pinned CDN ES Module)
  // ===========================================================================
  class TrysteroTransport {
    constructor(options) {
      const opts = options || {};
      this.adapterName = 'TrysteroTransport';
      this.customTurn = opts.turnConfig || null;
      this.role = null;
      this.roomCode = null;
      this.selfPeerId = null;
      this.hostPeerId = null;
      this.room = null;
      this.sendPayload = null;
      this.sendPing = null;
      this.sendPong = null;
      this.closed = false;

      this.openPeers = new Set();
      this.peerRtts = new Map();
      this.txMessages = 0;
      this.rxMessages = 0;
      this.signalingState = 'idle';
      this.candidateSummary = 'Waiting for WebRTC peers...';
      this.connectionType = 'Not connected';

      this._cbPeerJoin = null;
      this._cbPeerLeave = null;
      this._cbMessage = null;
      this._cbRoomReady = null;
      this._cbError = null;
      this._cbDiag = null;
      this._cbHostStatus = null;

      this.pingTimer = null;
      this.statsTimer = null;
    }

    onPeerJoin(cb) { this._cbPeerJoin = cb; }
    onPeerLeave(cb) { this._cbPeerLeave = cb; }
    onMessage(cb) { this._cbMessage = cb; }
    onRoomReady(cb) { this._cbRoomReady = cb; }
    onError(cb) { this._cbError = cb; }
    onDiag(cb) { this._cbDiag = cb; }
    onHostStatus(cb) { this._cbHostStatus = cb; }

    setTurnConfig(turn) {
      this.customTurn = turn && turn.urls ? turn : null;
    }

    async _loadTrystero() {
      if (root.__trysteroModule) return root.__trysteroModule;
      let lastErr = null;
      for (const url of TRYSTERO_CDN_URLS) {
        try {
          const mod = await import(url);
          if (mod && typeof mod.joinRoom === 'function') {
            root.__trysteroModule = mod;
            return mod;
          }
        } catch (e) {
          lastErr = e;
        }
      }
      throw new Error(
        'Unable to load Trystero CDN module (' + (lastErr ? lastErr.message : 'offline') + '). ' +
        'Check your internet connection or switch to Local WebSocket Signaling.'
      );
    }

    async createRoom(options) {
      const opts = options || {};
      this.role = 'host';
      const code = (opts.roomCode && /^[A-Z0-9]{6}$/.test(opts.roomCode))
        ? opts.roomCode
        : generateLocalRoomCode();
      await this._enterTrysteroRoom(code);
    }

    async joinRoom(code) {
      this.role = 'guest';
      const clean = String(code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(clean)) {
        if (this._cbError) this._cbError('Room codes are 6 characters long.');
        return;
      }
      await this._enterTrysteroRoom(clean);
    }

    async _enterTrysteroRoom(code) {
      this.closed = false;
      this.roomCode = code;
      this.signalingState = 'connecting';
      this._emitDiag();

      let mod;
      try {
        mod = await this._loadTrystero();
      } catch (e) {
        this.signalingState = 'offline';
        this._emitDiag();
        if (this._cbError) this._cbError(e.message);
        return;
      }

      try {
        const rtcConfig = {
          iceServers: buildIceServers(this.customTurn, false)
        };
        this.room = mod.joinRoom({ appId: TRYSTERO_APP_ID, rtcConfig }, `okey101-${code}`);
        this.selfPeerId = mod.selfId || 'self';
        this.signalingState = 'serverless-relays';

        const [sendMsg, getMsg] = this.room.makeAction('okeymsg');
        const [sendPing, getPing] = this.room.makeAction('okeyping');
        const [sendPong, getPong] = this.room.makeAction('okeypong');
        this.sendPayload = sendMsg;
        this.sendPing = sendPing;
        this.sendPong = sendPong;

        getMsg((data, peerId) => {
          this.rxMessages++;
          if (this.role === 'guest' && data && data.fromHost) {
            this.hostPeerId = peerId;
          }
          this._emitDiag();
          if (this._cbMessage) this._cbMessage(peerId, data);
        });

        getPing((ts, peerId) => {
          try { this.sendPong(ts, peerId); } catch (_) {}
        });

        getPong((ts, peerId) => {
          if (typeof ts === 'number') {
            const rtt = performance.now() - ts;
            const prev = this.peerRtts.get(peerId);
            this.peerRtts.set(peerId, prev == null ? rtt : prev * 0.7 + rtt * 0.3);
            this._emitDiag();
          }
        });

        this.room.onPeerJoin((peerId) => {
          this.openPeers.add(peerId);
          this._emitDiag();
          if (this._cbPeerJoin) this._cbPeerJoin(peerId);
        });

        this.room.onPeerLeave((peerId) => {
          this.openPeers.delete(peerId);
          this.peerRtts.delete(peerId);
          this._emitDiag();
          if (this.role === 'guest' && peerId === this.hostPeerId && this._cbHostStatus) {
            this._cbHostStatus('paused', 'Host peer disconnected.');
          }
          if (this._cbPeerLeave) this._cbPeerLeave(peerId, 'Peer disconnected.');
        });

        this._startLoops();
        this._emitDiag();

        if (this._cbRoomReady) {
          this._cbRoomReady({
            roomCode: this.roomCode,
            role: this.role,
            selfPeerId: this.selfPeerId
          });
        }
      } catch (e) {
        this.signalingState = 'offline';
        this._emitDiag();
        if (this._cbError) this._cbError('Failed to initialize Trystero room: ' + e.message);
      }
    }

    send(peerId, msg) {
      if (!this.sendPayload) return false;
      const target = peerId || this.hostPeerId;
      try {
        if (target) {
          this.sendPayload(msg, target);
        } else {
          this.sendPayload(msg);
        }
        this.txMessages++;
        return true;
      } catch (_) {
        return false;
      }
    }

    broadcast(msg) {
      if (!this.sendPayload || this.openPeers.size === 0) return 0;
      try {
        this.sendPayload(msg);
        this.txMessages += this.openPeers.size;
        return this.openPeers.size;
      } catch (_) {
        return 0;
      }
    }

    _startLoops() {
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.sendPing && this.openPeers.size > 0) {
          try { this.sendPing(performance.now()); } catch (_) {}
        }
      }, 2000);

      clearInterval(this.statsTimer);
      this.statsTimer = setInterval(async () => {
        if (!this.room || typeof this.room.getPeers !== 'function') return;
        const peersObj = this.room.getPeers();
        for (const pc of Object.values(peersObj || {})) {
          const info = await inspectPeerConnectionStats(pc);
          if (info) {
            this.connectionType = info.connectionType;
            this.candidateSummary = info.candidateSummary;
            this._emitDiag();
            break;
          }
        }
      }, 2000);
    }

    _emitDiag() {
      if (this._cbDiag) this._cbDiag(this.getDiagnostics());
    }

    getDiagnostics() {
      let sumRtt = 0;
      let count = 0;
      for (const rtt of this.peerRtts.values()) {
        sumRtt += rtt;
        count++;
      }
      const hasPeers = this.openPeers.size > 0;
      return {
        adapter: this.adapterName,
        signaling: this.signalingState,
        roomCode: this.roomCode,
        selfPeerId: this.selfPeerId,
        pcState: hasPeers ? 'connected' : 'waiting',
        dcState: hasPeers ? 'open (ordered, reliable)' : 'waiting',
        openPeerCount: this.openPeers.size,
        openPeers: Array.from(this.openPeers),
        rttMs: count > 0 ? Math.round(sumRtt / count) : null,
        txMessages: this.txMessages,
        rxMessages: this.rxMessages,
        connectionType: hasPeers ? this.connectionType : 'Not connected',
        candidateSummary: hasPeers ? this.candidateSummary : 'Waiting for peers'
      };
    }

    close() {
      this.closed = true;
      clearInterval(this.pingTimer);
      clearInterval(this.statsTimer);
      this.openPeers.clear();
      this.peerRtts.clear();
      if (this.room && typeof this.room.leave === 'function') {
        try { this.room.leave(); } catch (_) {}
      }
      this.room = null;
    }
  }

  function createTransport(mode, options) {
    if (mode === 'localws') {
      return new LocalWsTransport(options);
    }
    return new TrysteroTransport(options);
  }

  root.OkeyTransport = {
    LocalWsTransport,
    TrysteroTransport,
    createTransport,
    DEFAULT_ICE_SERVERS,
    TRYSTERO_CDN_URLS
  };
})(typeof self !== 'undefined' ? self : this);


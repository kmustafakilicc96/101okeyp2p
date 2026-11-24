/**
 * game.js
 * 4-Player 101 Okey — Host-Authoritative P2P Controller + Classic Turkish 101 Okey Table UI.
 *
 * Architecture:
 * - Seat 0 is the Host (room creator): holds the full authoritative state in memory + localStorage,
 *   validates all intents via Okey101Engine, enforces the turn timer, runs bot turns,
 *   and sends each guest ONLY their personalized STATE_SYNC (publicState + their own privateRack).
 * - Seats 1..3 are Guests (or Bots): send versioned intents (DRAW_STOCK, TAKE_DISCARD, RETURN_DISCARD,
 *   OPEN_MELDS, LAY_OFF, DISCARD) over reliable ordered WebRTC DataChannels to the Host.
 */
(function () {
  'use strict';

  const Engine = window.Okey101Engine;
  const TransportMod = window.OkeyTransport;
  const Strings = window.OKEY_STRINGS;

  const HOST_STORAGE_KEY = 'okey101_host_session_v1';
  const ACTIVE_SESSION_KEY = 'okey101_active_session_v1';
  const RACK_SLOTS_TOTAL = 28; // 2 rows x 14 slots

  const AVATARS = ['🧔🏻', '👩🏻‍🦰', '👴🏻', '👩🏻'];

  const $ = (id) => document.getElementById(id);
  const screens = {
    menu: $('screen-menu'),
    waiting: $('screen-waiting'),
    game: $('screen-game')
  };

  // ---------------------------------------------------------------------------
  // Client & Host Runtime State
  // ---------------------------------------------------------------------------
  let currentLang = 'tr';
  let transport = null;
  let transportMode = 'trystero'; // 'trystero' | 'localws'
  let role = null;                // 'host' | 'guest'
  let roomCode = null;
  let localSeat = null;           // 0..3
  let localSeatToken = null;
  let hostToken = null;
  let playerName = 'Alper';

  // Host-only state
  let hostState = null;
  const peerToSeat = new Map();   // peerId -> seat (1..3)
  const seatToPeer = new Map();   // seat (1..3) -> peerId
  let botTimer = null;
  let turnTickTimer = null;
  let autoNextRoundTimer = null;
  let autoNextRoundCountdownInterval = null;
  let autoNextRoundScheduledForRound = -1;
  let botDrawDelayMs = 520;       // Delay before bot draws from stock
  let botDiscardDelayMs = 680;    // Delay between bot's draw and bot's discard

  // Client view state (populated from STATE_SYNC for both Host and Guests)
  let publicState = null;
  let privateRack = [];           // Array of tile objects currently owned by local player
  let mustOpenWithTileId = null;
  let takenDiscardTileId = null;
  let clientSeq = 1;

  // Rack 2-row slot arrangement (array of 28 entries: tileId or null)
  let rackSlots = new Array(RACK_SLOTS_TOTAL).fill(null);
  let lastArrangedDealKey = null;
  let rackArrangeMode = 'runs'; // 'runs' (SERİ DİZ) | 'pairs' (ÇİFT DİZ)
  // Staged meld groups: Array of arrays of tileIds
  let stagedGroups = [[]];
  let activeStagedGroupIdx = 0;
  let selectedTileId = null;

  // Animation tracking state
  let lastAnimatedSeq = 0;
  let newlyDrawnTileId = null;
  let newlyDiscardedSeat = null;
  const newlyOpenedMeldIds = new Set();
  const newlyLaidOffTileIds = new Set();
  const lastKnownRackTileRects = new Map(); // tileId -> DOMRect before action

  // Ensure fixed FX animation overlay exists
  let fxOverlay = document.getElementById('fx-overlay');
  if (!fxOverlay) {
    fxOverlay = document.createElement('div');
    fxOverlay.id = 'fx-overlay';
    fxOverlay.className = 'fx-overlay';
    document.body.appendChild(fxOverlay);
  }

  // Privacy audit log of every network payload received by this client
  const receivedMessages = [];

  // ---------------------------------------------------------------------------
  // Localization (TR / EN)
  // ---------------------------------------------------------------------------
  function t(key) {
    const dict = Strings[currentLang] || Strings.tr;
    return dict[key] || Strings.en[key] || key;
  }

  function applyLanguage(lang) {
    currentLang = lang === 'en' ? 'en' : 'tr';
    $('btn-lang-en').classList.toggle('active', currentLang === 'en');
    $('btn-lang-tr').classList.toggle('active', currentLang === 'tr');
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    if (publicState) {
      renderLobbySeats();
      renderGameView();
    }
  }

  $('btn-lang-en').addEventListener('click', () => applyLanguage('en'));
  $('btn-lang-tr').addEventListener('click', () => applyLanguage('tr'));

  // ---------------------------------------------------------------------------
  // Full-Palette Istaka (Rack) Color Picker & 3D Shading Generator
  // ---------------------------------------------------------------------------
  const RACK_COLOR_STORAGE_KEY = 'okey101_rack_color_v1';
  const RACK_PRESET_COLORS = [
    { hex: '#a5611f', name: 'Klasik Ahşap (Classic Wood)' },
    { hex: '#991b1b', name: 'Bordo Kırmızı (Crimson)' },
    { hex: '#1e40af', name: 'Kraliyet Mavisi (Royal Blue)' },
    { hex: '#065f46', name: 'Zümrüt Yeşili (Emerald)' },
    { hex: '#5b21b6', name: 'Mor (Amethyst)' },
    { hex: '#b45309', name: 'Kehribar Altın (Amber)' },
    { hex: '#9d174d', name: 'Fuşya Pembe (Rose)' },
    { hex: '#0f766e', name: 'Turkuaz (Teal)' },
    { hex: '#334155', name: 'Gece Grisi (Slate)' }
  ];

  function normalizeHexColor(hex) {
    const clean = String(hex || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(clean)) return `#${clean.toLowerCase()}`;
    if (/^[0-9a-fA-F]{3}$/.test(clean)) {
      return `#${clean[0]}${clean[0]}${clean[1]}${clean[1]}${clean[2]}${clean[2]}`.toLowerCase();
    }
    return '#a5611f';
  }

  function shiftHexBrightness(hex, factor) {
    const norm = normalizeHexColor(hex).slice(1);
    let r = parseInt(norm.slice(0, 2), 16);
    let g = parseInt(norm.slice(2, 4), 16);
    let b = parseInt(norm.slice(4, 6), 16);
    if (factor >= 0) {
      r = Math.round(r + (255 - r) * factor);
      g = Math.round(g + (255 - g) * factor);
      b = Math.round(b + (255 - b) * factor);
    } else {
      const m = 1 + factor;
      r = Math.round(r * m);
      g = Math.round(g * m);
      b = Math.round(b * m);
    }
    const clamp = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
    return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
  }

  function applyRackColor(rawHex) {
    const baseHex = normalizeHexColor(rawHex);
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--istaka-base', baseHex);
    rootStyle.setProperty('--istaka-light', shiftHexBrightness(baseHex, 0.16));
    rootStyle.setProperty('--istaka-mid', shiftHexBrightness(baseHex, 0.08));
    rootStyle.setProperty('--istaka-dark', shiftHexBrightness(baseHex, -0.22));
    rootStyle.setProperty('--istaka-ledge', shiftHexBrightness(baseHex, -0.34));
    rootStyle.setProperty('--istaka-border', shiftHexBrightness(baseHex, -0.45));
    rootStyle.setProperty('--istaka-deep', shiftHexBrightness(baseHex, -0.56));

    try { localStorage.setItem(RACK_COLOR_STORAGE_KEY, baseHex); } catch (_) {}

    ['input-rack-color-menu', 'input-rack-color-lobby', 'input-rack-color-modal'].forEach((id) => {
      const inputEl = $(id);
      if (inputEl && inputEl.value.toLowerCase() !== baseHex) inputEl.value = baseHex;
    });
    ['rack-color-hex-menu', 'rack-color-hex-lobby', 'rack-color-hex-modal'].forEach((id) => {
      const lblEl = $(id);
      if (lblEl) lblEl.textContent = baseHex.toUpperCase();
    });
    document.querySelectorAll('.rack-swatch-btn[data-color]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.color === baseHex);
    });
  }

  function initRackColorPickers() {
    let savedHex = '#a5611f';
    try {
      const fromStorage = localStorage.getItem(RACK_COLOR_STORAGE_KEY);
      if (fromStorage) savedHex = normalizeHexColor(fromStorage);
    } catch (_) {}

    document.querySelectorAll('[data-rack-swatches]').forEach((container) => {
      container.innerHTML = '';
      RACK_PRESET_COLORS.forEach((preset) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rack-swatch-btn';
        btn.dataset.color = preset.hex;
        btn.title = preset.name;
        btn.style.background = `linear-gradient(180deg, ${shiftHexBrightness(preset.hex, 0.16)}, ${preset.hex})`;
        btn.addEventListener('click', () => applyRackColor(preset.hex));
        container.appendChild(btn);
      });
    });

    ['input-rack-color-menu', 'input-rack-color-lobby', 'input-rack-color-modal'].forEach((id) => {
      const inputEl = $(id);
      if (inputEl) {
        inputEl.addEventListener('input', (e) => applyRackColor(e.target.value));
        inputEl.addEventListener('change', (e) => applyRackColor(e.target.value));
      }
    });

    applyRackColor(savedHex);
  }
  initRackColorPickers();

  // ---------------------------------------------------------------------------
  // UI Helpers
  // ---------------------------------------------------------------------------
  function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
  }

  function showAlert(text, kind) {
    $('alert-text').textContent = text;
    $('alert-banner').classList.toggle('info', kind === 'info');
    $('alert-banner').classList.remove('hidden');
  }

  function hideAlert() {
    $('alert-banner').classList.add('hidden');
  }

  $('alert-close-btn').addEventListener('click', hideAlert);

  function toggleDrawer() {
    $('arena-drawer').classList.toggle('hidden');
  }
  if ($('btn-gear-drawer')) $('btn-gear-drawer').addEventListener('click', toggleDrawer);
  if ($('btn-toggle-drawer')) $('btn-toggle-drawer').addEventListener('click', toggleDrawer);

  function setPauseBanner(visible, customText) {
    const el = $('pause-banner');
    if (customText) $('pause-banner-text').textContent = customText;
    else $('pause-banner-text').textContent = t('gamePausedBanner');
    el.classList.toggle('hidden', !visible);
  }

  function setBadge(el, text, cls) {
    el.textContent = text;
    el.className = 'badge ' + cls;
  }

  let shareableBaseUrl = '';

  function getTurnConfigFromInputs() {
    const urlEl = $('input-turn-url');
    if (!urlEl) return null;
    const urls = urlEl.value.trim();
    if (!urls) return null;
    return {
      urls,
      username: $('input-turn-user') ? $('input-turn-user').value.trim() : '',
      credential: $('input-turn-pass') ? $('input-turn-pass').value : ''
    };
  }

  function generateSecretToken() {
    const arr = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < 12; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function getStoredSeatToken(code) {
    const key = `okey101_seat_token_${String(code).toUpperCase()}`;
    let tok = null;
    try { tok = localStorage.getItem(key); } catch (_) {}
    if (!tok) {
      tok = generateSecretToken();
      try { localStorage.setItem(key, tok); } catch (_) {}
    }
    return tok;
  }

  function setStoredSeatToken(code, token) {
    const key = `okey101_seat_token_${String(code).toUpperCase()}`;
    try { localStorage.setItem(key, token); } catch (_) {}
  }

  function saveHostSession() {
    if (role !== 'host' || !hostState) return;
    try {
      localStorage.setItem(HOST_STORAGE_KEY, JSON.stringify({
        roomCode,
        hostToken,
        transportMode,
        playerName,
        savedAt: Date.now(),
        state: hostState
      }));
      sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
        role: 'host',
        roomCode,
        hostToken,
        transportMode,
        playerName
      }));
    } catch (_) {}
  }

  function saveGuestSession() {
    if (role !== 'guest' || !roomCode || !localSeatToken) return;
    try {
      sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
        role: 'guest',
        roomCode,
        seatToken: localSeatToken,
        transportMode,
        playerName
      }));
    } catch (_) {}
  }

  function clearSavedSessions() {
    try {
      localStorage.removeItem(HOST_STORAGE_KEY);
      sessionStorage.removeItem(ACTIVE_SESSION_KEY);
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Transport Initialization & Wiring
  // ---------------------------------------------------------------------------
  function initTransport(mode) {
    if (transport) {
      transport.close(false);
      transport = null;
    }
    transportMode = mode || transportMode || 'trystero';
    transport = TransportMod.createTransport(transportMode, {
      turnConfig: getTurnConfigFromInputs()
    });

    transport.onRoomReady((info) => {
      roomCode = info.roomCode;
      if (info.hostToken) hostToken = info.hostToken;
      $('display-room-code').textContent = roomCode;
      $('diag-room-code').textContent = roomCode;
      try { history.replaceState(null, '', `#${roomCode}`); } catch (_) {}

      if (role === 'host') {
        if (!hostState) {
          const totalRounds = parseInt($('select-rounds').value || '1', 10);
          const turnSec = parseInt($('select-timer').value || '60', 10);
          hostState = Engine.createGameState({
            roomCode,
            totalRounds,
            config: Object.assign({}, Engine.SCORING_CONFIG, {
              DEFAULT_ROUNDS: totalRounds,
              TURN_TIMEOUT_SEC: turnSec
            }),
            seats: [
              { name: playerName || 'Alper', isBot: false, connected: true, seatToken: hostToken || generateSecretToken() },
              { name: 'Gamze', isBot: false, connected: false, seatToken: generateSecretToken() },
              { name: 'Zeynep', isBot: false, connected: false, seatToken: generateSecretToken() },
              { name: 'Mert', isBot: false, connected: false, seatToken: generateSecretToken() }
            ],
            autoStart: false
          });
        }
        localSeat = 0;
        localSeatToken = hostState.seats[0].seatToken;
        saveHostSession();
        syncAllSeats();

        if (hostState.phase === 'lobby') {
          $('waiting-role-tag').textContent = `${t('seatHost').toUpperCase()} (SEAT 1)`;
          $('waiting-role-tag').className = 'card-tag tag-host';
          $('host-lobby-controls').classList.remove('hidden');
          $('guest-lobby-notice').classList.add('hidden');
          showScreen('waiting');
          renderLobbySeats();
        } else {
          showScreen('game');
          startHostTimers();
          renderGameView();
        }
      } else {
        $('waiting-role-tag').textContent = `${t('seatGuest').toUpperCase()}`;
        $('waiting-role-tag').className = 'card-tag tag-guest';
        $('host-lobby-controls').classList.add('hidden');
        $('guest-lobby-notice').classList.remove('hidden');
        showScreen('waiting');
      }
      updateDiagnosticsUI(transport.getDiagnostics());
    });

    transport.onPeerJoin((peerId) => {
      updateDiagnosticsUI(transport.getDiagnostics());
      if (role === 'guest') {
        localSeatToken = localSeatToken || getStoredSeatToken(roomCode);
        saveGuestSession();
        transport.send(peerId, {
          v: 1,
          seq: clientSeq++,
          type: 'HELLO_SEAT',
          name: playerName,
          seatToken: localSeatToken
        });
      }
    });

    transport.onPeerLeave((peerId) => {
      updateDiagnosticsUI(transport.getDiagnostics());
      if (role === 'host' && hostState) {
        const seat = peerToSeat.get(peerId);
        if (seat !== undefined) {
          peerToSeat.delete(peerId);
          seatToPeer.delete(seat);
          hostState.seats[seat].connected = false;
          // If we are at roundEnd/matchEnd and a guest leaves/disconnects, treat as declined (convert to bot if others accepted)
          if (hostState.phase === 'roundEnd' || hostState.phase === 'matchEnd') {
            Engine.applyIntent(hostState, seat, { type: 'READY_NEXT', accept: false });
            if (hostState.phase === 'playing') {
              resetTurnTimer();
              startHostTimers();
            }
          } else {
            hostState.seq++;
          }
          saveHostSession();
          syncAllSeats();
        }
      }
    });

    transport.onHostStatus((status) => {
      if (role === 'guest') {
        if (status === 'paused') {
          setPauseBanner(true);
          setBadge($('webrtc-badge'), t('p2pPaused'), 'badge-warn');
        } else if (status === 'connected') {
          setPauseBanner(false);
          setBadge($('webrtc-badge'), t('p2pActive'), 'badge-ok');
        } else if (status === 'closed') {
          setPauseBanner(false);
          leaveToMenu('The host closed the room.');
        }
      }
    });

    transport.onMessage((peerId, msg) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (role === 'host') {
        handleHostMessage(peerId, msg);
      } else {
        handleGuestMessage(peerId, msg);
      }
    });

    transport.onError((errText) => {
      showAlert(errText);
    });

    transport.onDiag((diag) => {
      updateDiagnosticsUI(diag);
    });

    return transport;
  }

  // ---------------------------------------------------------------------------
  // Host Protocol Handlers
  // ---------------------------------------------------------------------------
  function handleHostMessage(peerId, msg) {
    if (!hostState) return;

    if (msg.type === 'HELLO_SEAT') {
      const reqToken = msg.seatToken ? String(msg.seatToken) : generateSecretToken();
      const guestName = (msg.name && String(msg.name).trim().slice(0, 18)) || '';

      let assignedSeat = null;
      for (let s = 1; s <= 3; s++) {
        if (hostState.seats[s].seatToken === reqToken) {
          assignedSeat = s;
          break;
        }
      }

      if (assignedSeat === null && hostState.phase === 'lobby') {
        for (let s = 1; s <= 3; s++) {
          if (!hostState.seats[s].connected && !hostState.seats[s].isBot) {
            assignedSeat = s;
            break;
          }
        }
      }

      if (assignedSeat === null) {
        transport.send(peerId, {
          v: 1,
          seq: hostState.seq,
          fromHost: true,
          type: 'JOIN_REJECTED',
          reason: 'Room is full or match is already in progress.'
        });
        return;
      }

      const oldPeer = seatToPeer.get(assignedSeat);
      if (oldPeer && oldPeer !== peerId) {
        peerToSeat.delete(oldPeer);
      }
      peerToSeat.set(peerId, assignedSeat);
      seatToPeer.set(assignedSeat, peerId);

      const seatObj = hostState.seats[assignedSeat];
      seatObj.connected = true;
      seatObj.isBot = false;
      seatObj.seatToken = reqToken;
      if (guestName) seatObj.name = guestName;

      hostState.seq++;
      saveHostSession();

      transport.send(peerId, {
        v: 1,
        seq: hostState.seq,
        fromHost: true,
        type: 'SEAT_ASSIGNED',
        seat: assignedSeat,
        seatToken: seatObj.seatToken,
        roomCode: hostState.roomCode
      });

      syncAllSeats();
      return;
    }

    if (msg.type === 'INTENT') {
      const seat = peerToSeat.get(peerId);
      if (seat === undefined) {
        transport.send(peerId, {
          v: 1,
          seq: hostState.seq,
          fromHost: true,
          type: 'INTENT_REJECTED',
          reason: 'Unassigned seat.'
        });
        return;
      }

      const prevTurn = hostState.currentTurn;
      const prevPhase = hostState.phase;
      const res = Engine.applyIntent(hostState, seat, msg.intent);
      if (!res.ok) {
        transport.send(peerId, {
          v: 1,
          seq: hostState.seq,
          fromHost: true,
          type: 'INTENT_REJECTED',
          intentType: msg.intent && msg.intent.type,
          reason: res.reason
        });
        return;
      }

      // If a guest declined playing again, unbind their peer map so the new Bot takes over cleanly
      if (msg.intent && msg.intent.type === 'READY_NEXT' && msg.intent.accept === false) {
        peerToSeat.delete(peerId);
        seatToPeer.delete(seat);
      }

      if (hostState.phase === 'playing' && (hostState.currentTurn !== prevTurn || prevPhase !== 'playing')) {
        resetTurnTimer();
      }
      saveHostSession();
      syncAllSeats();
      scheduleBotIfNeeded();
      return;
    }

    if (msg.type === 'GUEST_LEAVE') {
      const seat = peerToSeat.get(peerId);
      if (seat !== undefined) {
        peerToSeat.delete(peerId);
        seatToPeer.delete(seat);
        hostState.seats[seat].connected = false;
        if (hostState.phase === 'lobby') {
          hostState.seats[seat].seatToken = generateSecretToken();
        }
        hostState.seq++;
        saveHostSession();
        syncAllSeats();
      }
    }
  }

  function syncAllSeats() {
    if (role !== 'host' || !hostState) return;
    const hostSync = Engine.getStateSyncForSeat(hostState, 0);
    applyStateSyncPayload(hostSync);

    for (const [peerId, seat] of peerToSeat.entries()) {
      const guestSync = Engine.getStateSyncForSeat(hostState, seat);
      guestSync.fromHost = true;
      transport.send(peerId, guestSync);
    }
  }

  function resetTurnTimer() {
    if (!hostState || hostState.phase !== 'playing') return;
    const sec = (hostState.config && hostState.config.TURN_TIMEOUT_SEC) || 60;
    hostState.turnDeadlineMs = Date.now() + sec * 1000;
  }

  function startHostTimers() {
    clearInterval(turnTickTimer);
    if (role !== 'host') return;
    if (hostState && hostState.phase === 'playing' && !hostState.turnDeadlineMs) {
      resetTurnTimer();
    }
    turnTickTimer = setInterval(() => {
      if (!hostState || hostState.phase !== 'playing') return;
      renderTimerBadge();
      const activeSeat = hostState.seats[hostState.currentTurn];
      if (!activeSeat) return;
      if (!activeSeat.isBot && hostState.turnDeadlineMs && Date.now() >= hostState.turnDeadlineMs) {
        const r = Engine.runBotTurn(hostState, hostState.currentTurn);
        if (r.ok) {
          resetTurnTimer();
          saveHostSession();
          syncAllSeats();
          scheduleBotIfNeeded();
        }
      }
    }, 500);
    scheduleBotIfNeeded();
  }

  function scheduleBotIfNeeded() {
    clearTimeout(botTimer);
    if (role !== 'host' || !hostState || hostState.phase !== 'playing') return;
    const cur = hostState.currentTurn;
    const activeSeat = hostState.seats[cur];
    if (!activeSeat || !activeSeat.isBot) return;

    // Two-stage bot turn with a visible pause between Drawing and Discarding
    // (Bots cannot open their hands; they only draw from the center pile and discard).
    const isDrawStep = hostState.turnPhase === 'draw';
    const delay = isDrawStep ? botDrawDelayMs : botDiscardDelayMs;

    botTimer = setTimeout(() => {
      if (!hostState || hostState.phase !== 'playing') return;
      if (hostState.currentTurn !== cur || !hostState.seats[cur].isBot) return;

      if (hostState.turnPhase === 'draw') {
        const drawRes = Engine.applyIntent(hostState, cur, { type: 'DRAW_STOCK' });
        if (drawRes.ok) {
          saveHostSession();
          syncAllSeats();
          // Now schedule the discard step after botDiscardDelayMs
          scheduleBotIfNeeded();
        }
      } else if (hostState.turnPhase === 'act') {
        const botPlayer = hostState.seats[cur];
        const discardTile = Engine.chooseSafeDiscardTile(
          botPlayer.rack,
          hostState.indicator,
          hostState.tableMelds,
          hostState.config
        );
        if (discardTile) {
          const discRes = Engine.applyIntent(hostState, cur, { type: 'DISCARD', tileId: discardTile.id });
          if (discRes.ok) {
            resetTurnTimer();
            saveHostSession();
            syncAllSeats();
            scheduleBotIfNeeded();
          }
        }
      }
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Guest Protocol Handlers
  // ---------------------------------------------------------------------------
  function handleGuestMessage(peerId, msg) {
    receivedMessages.push(JSON.parse(JSON.stringify(msg)));

    switch (msg.type) {
      case 'JOIN_REJECTED':
        leaveToMenu(msg.reason || 'Unable to join room.');
        break;

      case 'SEAT_ASSIGNED':
        localSeat = msg.seat;
        localSeatToken = msg.seatToken;
        setStoredSeatToken(msg.roomCode || roomCode, localSeatToken);
        saveGuestSession();
        setPauseBanner(false);
        break;

      case 'STATE_SYNC':
        setPauseBanner(false);
        applyStateSyncPayload(msg);
        break;

      case 'INTENT_REJECTED':
        showAlert(msg.reason || 'Move rejected by host.');
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Action & Rack FLIP Animation Engine
  // ---------------------------------------------------------------------------
  function captureCurrentRackRects() {
    const map = new Map();
    document.querySelectorAll('#player-rack-board .okey-tile[data-tile-id]').forEach((el) => {
      const id = Number(el.dataset.tileId);
      if (id) map.set(id, el.getBoundingClientRect());
    });
    return map;
  }

  function playRackFLIP(oldRects, durationMs = 280) {
    if (!oldRects || oldRects.size === 0) return;
    document.querySelectorAll('#player-rack-board .okey-tile[data-tile-id]').forEach((el) => {
      const id = Number(el.dataset.tileId);
      const prev = oldRects.get(id);
      if (!prev) return;
      const next = el.getBoundingClientRect();
      const unitScale = (el.offsetWidth > 0 ? next.width / el.offsetWidth : 1) || 1;
      const dx = (prev.left - next.left) / unitScale;
      const dy = (prev.top - next.top) / unitScale;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      if (typeof el.animate === 'function') {
        el.animate([
          { transform: `translate(${dx}px, ${dy}px) scale(1.04)` },
          { transform: 'translate(0, 0) scale(1)' }
        ], {
          duration: durationMs,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
        });
      }
    });
  }

  function getPlaqueElementForSeat(seat) {
    const mySeat = localSeat != null ? localSeat : 0;
    if (seat === mySeat) return $('plaque-bottom');
    if (seat === (mySeat + 1) % 4) return $('plaque-right');
    if (seat === (mySeat + 2) % 4) return $('plaque-top');
    return $('plaque-left');
  }

  function getDiscardSlotElementForSeat(seat) {
    const mySeat = localSeat != null ? localSeat : 0;
    if (seat === mySeat) return $('discard-slot-bottom');
    if (seat === (mySeat + 1) % 4) return $('discard-slot-right');
    if (seat === (mySeat + 2) % 4) return $('discard-slot-top');
    return $('discard-slot-left');
  }

  function pulsePlaqueForSeat(seat) {
    const el = getPlaqueElementForSeat(seat);
    if (!el) return;
    el.classList.remove('plaque-anim-pulse');
    void el.offsetWidth;
    el.classList.add('plaque-anim-pulse');
  }

  function spawnFlyingTile(opts) {
    if (!fxOverlay || !opts || !opts.fromRect || !opts.toRect) return;
    const { fromRect, toRect, tile, indicator, faceDown, durationMs = 340, delayMs = 0, targetEl } = opts;
    if (fromRect.width === 0 || toRect.width === 0) return;

    let ghost;
    if (faceDown || !tile) {
      ghost = document.createElement('div');
      ghost.className = 'okey-tile tile-sm fx-flying-tile face-down';
    } else {
      ghost = createTileElement(tile, indicator, { small: true });
      ghost.classList.add('fx-flying-tile');
      ghost.classList.remove('selected');
    }

    // Measure CSS-pixel-to-viewport-rect scale factor (handles any body CSS zoom such as 1.25)
    ghost.style.transformOrigin = '0 0';
    ghost.style.width = '50px';
    ghost.style.height = '70px';
    ghost.style.transform = 'translate(0px, 0px)';
    fxOverlay.appendChild(ghost);

    const probeRect = ghost.getBoundingClientRect();
    const unitScale = (probeRect.width > 0 ? probeRect.width / 50 : 1) || 1;
    const originX = probeRect.left || 0;
    const originY = probeRect.top || 0;

    const cssFromW = Math.max(24, fromRect.width / unitScale);
    const cssFromH = Math.max(34, fromRect.height / unitScale);
    const cssToW = Math.max(24, toRect.width / unitScale);
    const cssToH = Math.max(34, toRect.height / unitScale);

    const startX = (fromRect.left - originX) / unitScale;
    const startY = (fromRect.top - originY) / unitScale;
    const endX = (toRect.left - originX) / unitScale;
    const endY = (toRect.top - originY) / unitScale;

    ghost.style.width = `${cssFromW}px`;
    ghost.style.height = `${cssFromH}px`;
    ghost.style.transform = `translate(${startX}px, ${startY}px)`;

    if (targetEl) {
      targetEl.style.opacity = '0';
    }

    const scaleX = cssToW / cssFromW;
    const scaleY = cssToH / cssFromH;
    const midX = (startX + endX) / 2;
    const midY = Math.min(startY, endY) - 18;

    if (typeof ghost.animate === 'function') {
      const anim = ghost.animate([
        { transform: `translate(${startX}px, ${startY}px) scale(1)`, opacity: 1 },
        { transform: `translate(${midX}px, ${midY}px) scale(${Math.max(1.06, (1 + scaleX) / 2)})`, opacity: 1, offset: 0.5 },
        { transform: `translate(${endX}px, ${endY}px) scale(${scaleX}, ${scaleY})`, opacity: 0.96 }
      ], {
        duration: durationMs,
        delay: delayMs,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'both'
      });
      anim.onfinish = () => {
        if (targetEl) targetEl.style.opacity = '';
        ghost.remove();
      };
    } else {
      setTimeout(() => {
        if (targetEl) targetEl.style.opacity = '';
        ghost.remove();
      }, durationMs + delayMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Applying STATE_SYNC & Rack / Meld Grouping Helpers
  // ---------------------------------------------------------------------------
  function applyStateSyncPayload(syncMsg) {
    if (!syncMsg || !syncMsg.publicState || !syncMsg.privateRack) return;
    const prevPub = publicState;
    const prevPhase = prevPub ? prevPub.phase : null;
    const prevRound = prevPub ? prevPub.roundIndex : null;
    const prevRackIds = new Set(privateRack.map((t) => t.id));
    const prevMeldMap = new Map(((prevPub && prevPub.tableMelds) || []).map((m) => [m.id, m]));

    // Snapshot current rack tile screen coordinates before updating DOM
    const oldRects = captureCurrentRackRects();
    oldRects.forEach((r, id) => lastKnownRackTileRects.set(id, r));

    localSeat = syncMsg.seat;
    publicState = syncMsg.publicState;
    privateRack = syncMsg.privateRack.rack || [];
    mustOpenWithTileId = syncMsg.privateRack.mustOpenWithTileId;
    takenDiscardTileId = syncMsg.privateRack.takenDiscardTileId != null
      ? syncMsg.privateRack.takenDiscardTileId
      : mustOpenWithTileId;

    // Detect action changes for animations
    newlyDrawnTileId = null;
    newlyDiscardedSeat = null;
    newlyOpenedMeldIds.clear();
    newlyLaidOffTileIds.clear();

    const act = publicState.lastAction;
    const isNewSeq = publicState.seq !== lastAnimatedSeq;
    if (isNewSeq && act) {
      lastAnimatedSeq = publicState.seq;
      if ((act.type === 'DRAW_STOCK' || act.type === 'TAKE_DISCARD') && act.seat === localSeat) {
        for (const t of privateRack) {
          if (!prevRackIds.has(t.id)) {
            newlyDrawnTileId = t.id;
            break;
          }
        }
      } else if (act.type === 'DISCARD' || act.type === 'GO_OUT') {
        newlyDiscardedSeat = act.seat;
      } else if (act.type === 'OPEN_MELDS' || act.type === 'ADD_MELDS') {
        for (const m of (publicState.tableMelds || [])) {
          if (!prevMeldMap.has(m.id)) newlyOpenedMeldIds.add(m.id);
        }
      } else if (act.type === 'LAY_OFF' && Array.isArray(act.tiles)) {
        act.tiles.forEach((t) => { if (t && t.id) newlyLaidOffTileIds.add(t.id); });
        if (act.retrievedOkey && act.seat === localSeat) {
          newlyDrawnTileId = act.retrievedOkey.id;
        }
      }
    }

    const currentDealKey = `${publicState.roomCode}:${publicState.roundIndex}:${publicState.dealCounter || 0}:${publicState.rematchCount || 0}`;
    const isNewRoundStart =
      currentDealKey !== lastArrangedDealKey ||
      prevRound !== publicState.roundIndex ||
      (prevPhase !== 'playing' && publicState.phase === 'playing') ||
      (isNewSeq && act && act.type === 'ROUND_START');

    if (isNewRoundStart && publicState.phase === 'playing') {
      lastArrangedDealKey = currentDealKey;
      rackArrangeMode = 'runs';
      stagedGroups = [[]];
      activeStagedGroupIdx = 0;
      selectedTileId = null;
      rackSlots = new Array(RACK_SLOTS_TOTAL).fill(null);
      autoArrangeRackWithGaps('runs');
    }
    reconcileRackAndStaged();

    if (publicState.phase === 'lobby') {
      showScreen('waiting');
      renderLobbySeats();
    } else {
      showScreen('game');
      renderGameView();
      if (isNewSeq && act && prevPub && prevPub.phase === 'playing') {
        runActionVisualEffects(act, oldRects);
      }
      // Clear one-shot action animation flags so subsequent rack clicks never re-glow the drawn tile
      newlyDrawnTileId = null;
      newlyDiscardedSeat = null;
      newlyOpenedMeldIds.clear();
      newlyLaidOffTileIds.clear();
    }
  }

  function runActionVisualEffects(act, oldRects) {
    if (!publicState || !act) return;
    const ind = publicState.indicator;
    const mySeat = localSeat != null ? localSeat : 0;

    if (act.type === 'DRAW_STOCK') {
      const stockEl = $('btn-draw-stock');
      const fromRect = stockEl ? stockEl.getBoundingClientRect() : null;
      if (act.seat === mySeat && newlyDrawnTileId != null) {
        const destTileEl = document.querySelector(`#player-rack-board .okey-tile[data-tile-id="${newlyDrawnTileId}"]`);
        const tileObj = getTileById(newlyDrawnTileId);
        if (fromRect && destTileEl) {
          spawnFlyingTile({
            fromRect,
            toRect: destTileEl.getBoundingClientRect(),
            tile: tileObj,
            indicator: ind,
            faceDown: false,
            durationMs: 360,
            targetEl: destTileEl
          });
        }
      } else if (act.seat !== mySeat) {
        pulsePlaqueForSeat(act.seat);
        const plaqueEl = getPlaqueElementForSeat(act.seat);
        if (fromRect && plaqueEl) {
          spawnFlyingTile({
            fromRect,
            toRect: plaqueEl.getBoundingClientRect(),
            faceDown: true,
            durationMs: 360
          });
        }
      }
    } else if (act.type === 'TAKE_DISCARD') {
      const fromSlotEl = getDiscardSlotElementForSeat(act.fromSeat != null ? act.fromSeat : (act.seat + 3) % 4);
      const fromRect = fromSlotEl ? fromSlotEl.getBoundingClientRect() : null;
      if (act.seat === mySeat && newlyDrawnTileId != null) {
        const destTileEl = document.querySelector(`#player-rack-board .okey-tile[data-tile-id="${newlyDrawnTileId}"]`);
        if (fromRect && destTileEl) {
          spawnFlyingTile({
            fromRect,
            toRect: destTileEl.getBoundingClientRect(),
            tile: act.tile || getTileById(newlyDrawnTileId),
            indicator: ind,
            faceDown: false,
            durationMs: 360,
            targetEl: destTileEl
          });
        }
      } else if (act.seat !== mySeat) {
        pulsePlaqueForSeat(act.seat);
        const plaqueEl = getPlaqueElementForSeat(act.seat);
        if (fromRect && plaqueEl) {
          spawnFlyingTile({
            fromRect,
            toRect: plaqueEl.getBoundingClientRect(),
            tile: act.tile,
            indicator: ind,
            faceDown: false,
            durationMs: 360
          });
        }
      }
    } else if (act.type === 'RETURN_DISCARD') {
      const toSlotEl = getDiscardSlotElementForSeat(act.toSeat != null ? act.toSeat : (act.seat + 3) % 4);
      const fromRect = (act.tile && lastKnownRackTileRects.get(act.tile.id)) ||
        (getPlaqueElementForSeat(act.seat) && getPlaqueElementForSeat(act.seat).getBoundingClientRect());
      if (fromRect && toSlotEl) {
        spawnFlyingTile({
          fromRect,
          toRect: toSlotEl.getBoundingClientRect(),
          tile: act.tile,
          indicator: ind,
          faceDown: false,
          durationMs: 320
        });
      }
    } else if (act.type === 'DISCARD' || act.type === 'GO_OUT') {
      const toSlotEl = getDiscardSlotElementForSeat(act.seat);
      const destTileEl = toSlotEl ? toSlotEl.querySelector('.okey-tile') : null;
      let fromRect = null;
      if (act.seat === mySeat && act.tile) {
        fromRect = (oldRects && oldRects.get(act.tile.id)) || lastKnownRackTileRects.get(act.tile.id);
      }
      if (!fromRect) {
        pulsePlaqueForSeat(act.seat);
        const plaqueEl = getPlaqueElementForSeat(act.seat);
        fromRect = plaqueEl ? plaqueEl.getBoundingClientRect() : null;
      }
      if (fromRect && toSlotEl) {
        spawnFlyingTile({
          fromRect,
          toRect: (destTileEl || toSlotEl).getBoundingClientRect(),
          tile: act.tile,
          indicator: ind,
          faceDown: false,
          durationMs: 350,
          targetEl: destTileEl
        });
      }
    } else if (act.type === 'OPEN_MELDS' || act.type === 'ADD_MELDS') {
      pulsePlaqueForSeat(act.seat);
      const fallbackPlaque = getPlaqueElementForSeat(act.seat);
      const fallbackRect = fallbackPlaque ? fallbackPlaque.getBoundingClientRect() : null;
      let delayIdx = 0;
      newlyOpenedMeldIds.forEach((meldId) => {
        const clusterEl = document.querySelector(`.meld-cluster[data-meld-id="${meldId}"]`);
        if (!clusterEl) return;
        clusterEl.querySelectorAll('.okey-tile[data-tile-id]').forEach((tileEl) => {
          const tid = Number(tileEl.dataset.tileId);
          const fromRect = (act.seat === mySeat && ((oldRects && oldRects.get(tid)) || lastKnownRackTileRects.get(tid))) || fallbackRect;
          const meldObj = (publicState.tableMelds || []).find((m) => m.id === meldId);
          const tileObj = meldObj ? meldObj.tiles.find((t) => t.id === tid) : null;
          if (fromRect) {
            spawnFlyingTile({
              fromRect,
              toRect: tileEl.getBoundingClientRect(),
              tile: tileObj,
              indicator: ind,
              faceDown: false,
              durationMs: 340,
              delayMs: delayIdx * 38,
              targetEl: tileEl
            });
            delayIdx++;
          }
        });
      });
    } else if (act.type === 'LAY_OFF') {
      pulsePlaqueForSeat(act.seat);
      const fallbackPlaque = getPlaqueElementForSeat(act.seat);
      const fallbackRect = fallbackPlaque ? fallbackPlaque.getBoundingClientRect() : null;
      const clusterEl = document.querySelector(`.meld-cluster[data-meld-id="${act.meldId}"]`);
      if (clusterEl && Array.isArray(act.tiles)) {
        act.tiles.forEach((t, idx) => {
          const tileEl = clusterEl.querySelector(`.okey-tile[data-tile-id="${t.id}"]`) || clusterEl;
          const fromRect = (act.seat === mySeat && ((oldRects && oldRects.get(t.id)) || lastKnownRackTileRects.get(t.id))) || fallbackRect;
          if (fromRect) {
            spawnFlyingTile({
              fromRect,
              toRect: tileEl.getBoundingClientRect(),
              tile: t,
              indicator: ind,
              faceDown: false,
              durationMs: 330,
              delayMs: idx * 70,
              targetEl: tileEl !== clusterEl ? tileEl : null
            });
          }
        });
      }
      // If a Joker (Okey) was retrieved from the meld, animate it flying from the meld back into the player's rack (or plaque)!
      if (act.retrievedOkey && clusterEl) {
        const meldRect = clusterEl.getBoundingClientRect();
        if (act.seat === mySeat) {
          const destOkeyEl = document.querySelector(`#player-rack-board .okey-tile[data-tile-id="${act.retrievedOkey.id}"]`);
          if (destOkeyEl) {
            spawnFlyingTile({
              fromRect: meldRect,
              toRect: destOkeyEl.getBoundingClientRect(),
              tile: act.retrievedOkey,
              indicator: ind,
              faceDown: false,
              durationMs: 380,
              delayMs: 80,
              targetEl: destOkeyEl
            });
          }
        } else if (fallbackRect) {
          spawnFlyingTile({
            fromRect: meldRect,
            toRect: fallbackRect,
            tile: act.retrievedOkey,
            indicator: ind,
            faceDown: false,
            durationMs: 380,
            delayMs: 80
          });
        }
      }
    }

    // Display toast notification whenever a player incurs a +101 penalty (playable tile discarded, Okey discarded, or table Okey stolen)
    if (act.penaltyPoints > 0 && act.penaltySeat != null && publicState.seats[act.penaltySeat]) {
      const pName = publicState.seats[act.penaltySeat].name;
      let penMsg = '';
      if (act.penaltyReason === 'OKEY_STOLEN') {
        penMsg = currentLang === 'en'
          ? `${pName} received +${act.penaltyPoints} penalty because their table Okey was taken!`
          : `${pName} açtığı perdeki Okey alındığı için +${act.penaltyPoints} ceza aldı!`;
      } else if (act.penaltyReason === 'DISCARD_PLAYABLE') {
        penMsg = currentLang === 'en'
          ? `${pName} received +${act.penaltyPoints} penalty for discarding a playable (işlek) tile!`
          : `${pName} ortadaki serilere işlek taş attığı için +${act.penaltyPoints} ceza aldı!`;
      } else if (act.penaltyReason === 'DISCARD_OKEY') {
        penMsg = currentLang === 'en'
          ? `${pName} received +${act.penaltyPoints} penalty for discarding an Okey!`
          : `${pName} yere Okey attığı için +${act.penaltyPoints} ceza aldı!`;
      }
      if (penMsg) {
        showAlert(penMsg);
        pulsePlaqueForSeat(act.penaltySeat);
      }
    }
  }

  /**
   * Arranges the player's tiles on the 2-row wooden rack with empty-slot gaps between valid meld groups
   * and places all remaining ungrouped tiles contiguously on Row 2 (sorted by color & ascending number),
   * matching the reference laid-out hand photo ([7 6 5] _ [10 10 10] _ [4 4 4] _ [1 1 1] on Row 1,
   * and contiguous leftovers [1 2 5 3 4 7 13 6 6] on Row 2).
   */
  function autoArrangeRackWithGaps(mode) {
    if (!publicState || !publicState.indicator || privateRack.length === 0) return;
    const ind = publicState.indicator;
    const stagedSet = new Set(stagedGroups.flat());
    const unStaged = privateRack.filter((t) => !stagedSet.has(t.id));
    rackSlots = new Array(RACK_SLOTS_TOTAL).fill(null);

    const cand = Engine.findBestMeldsInRack(unStaged, ind, mustOpenWithTileId);
    const groups = mode === 'sets'
      ? (cand.pairsCandidate.melds.length >= 1 ? cand.pairsCandidate.melds : cand.setsCandidate.melds)
      : cand.setsCandidate.melds;

    const used = new Set();
    const row0Clusters = [];
    const row1Clusters = [];

    for (const m of groups) {
      const usedSlots0 = row0Clusters.reduce((s, c) => s + c.length, 0) + row0Clusters.length;
      const usedSlots1 = row1Clusters.reduce((s, c) => s + c.length, 0) + row1Clusters.length;
      if (usedSlots0 + m.length <= 14) {
        row0Clusters.push(m);
        m.forEach((t) => used.add(t.id));
      } else if (usedSlots1 + m.length <= 14) {
        row1Clusters.push(m);
        m.forEach((t) => used.add(t.id));
      }
    }

    // Sort remaining leftover tiles cleanly: in 'runs' mode by color (black, blue, red, yellow/green) & ascending number;
    // in 'sets' mode by number then color so near-pairs sit next to each other.
    const rawLeftovers = unStaged.filter((t) => !used.has(t.id));
    const colorRank = { black: 0, blue: 1, red: 2, yellow: 3 };
    const leftovers = mode === 'sets'
      ? Engine.sortRackBySets(rawLeftovers, ind)
      : rawLeftovers.slice().sort((a, b) => {
          const ea = Engine.getEffectiveTile(a, ind);
          const eb = Engine.getEffectiveTile(b, ind);
          if (ea.isWild !== eb.isWild) return ea.isWild ? 1 : -1;
          if (ea.color !== eb.color) return (colorRank[ea.color] ?? 9) - (colorRank[eb.color] ?? 9);
          if (ea.number !== eb.number) return ea.number - eb.number;
          return a.id - b.id;
        });

    // 1. Place row0Clusters on Row 0 (slots 0..13) with 1 empty slot gap between clusters
    let idx0 = 0;
    for (const cluster of row0Clusters) {
      if (idx0 > 0 && idx0 < 14) idx0++; // 1-slot gap between valid melds
      for (const tile of cluster) {
        if (idx0 < 14) rackSlots[idx0++] = tile.id;
      }
    }

    // 2. Place row1Clusters on Row 1 (slots 14..27) with 1 empty slot gap between clusters
    let idx1 = 14;
    for (const cluster of row1Clusters) {
      if (idx1 > 14 && idx1 < 28) idx1++; // 1-slot gap between valid melds
      for (const tile of cluster) {
        if (idx1 < 28) rackSlots[idx1++] = tile.id;
      }
    }

    // 3. Place leftover (unused) ungrouped tiles contiguously:
    //    First fill Row 1 (leaving a 1-slot gap after any melds on Row 1).
    //    Any unused tiles that go onto Row 0 (the upper row) are placed flush at the RIGHT END of Row 0 (..slot 13).
    let startRow1Leftovers = idx1 > 14 ? idx1 + 1 : 14;
    const availRow1 = Math.max(0, 28 - startRow1Leftovers);
    const minRow0LeftoverSlot = idx0 > 0 ? idx0 + 1 : 0;
    const availRow0 = Math.max(0, 14 - minRow0LeftoverSlot);

    if (leftovers.length > availRow1 + availRow0 && startRow1Leftovers > idx1) {
      startRow1Leftovers = idx1;
    }

    let lIdx = 0;
    for (let slot = startRow1Leftovers; slot < 28 && lIdx < leftovers.length; slot++) {
      rackSlots[slot] = leftovers[lIdx++].id;
    }
    const remForRow0 = leftovers.length - lIdx;
    if (remForRow0 > 0) {
      const row0Start = Math.max(minRow0LeftoverSlot, 14 - remForRow0);
      for (let slot = row0Start; slot < 14 && lIdx < leftovers.length; slot++) {
        rackSlots[slot] = leftovers[lIdx++].id;
      }
    }
  }

  /**
   * Scans the 2 rows of the wooden rack for contiguous tile groups (separated by empty slots)
   * and returns valid melds + total series points and valid pair counts.
   */
  function analyzeRackContiguousGroups() {
    if (!publicState || !publicState.indicator) {
      return { seriesMelds: [], seriesPoints: 0, pairMelds: [], pairCount: 0 };
    }
    const ind = publicState.indicator;
    const rawClusters = [];

    for (const [start, end] of [[0, 13], [14, 27]]) {
      let current = [];
      for (let i = start; i <= end; i++) {
        const tid = rackSlots[i];
        const tile = tid != null ? getTileById(tid) : null;
        if (tile) {
          current.push(tile);
        } else if (current.length > 0) {
          rawClusters.push(current);
          current = [];
        }
      }
      if (current.length > 0) rawClusters.push(current);
    }

    const seriesMelds = [];
    let seriesPoints = 0;
    const pairMelds = [];

    for (const cluster of rawClusters) {
      if (cluster.length === 2) {
        const vp = Engine.validatePair(cluster, ind);
        if (vp.valid) pairMelds.push(cluster.map((t) => t.id));
      } else if (cluster.length >= 3) {
        const vm = Engine.validateMeld(cluster, ind);
        if (vm.valid && vm.kind !== 'pair') {
          seriesMelds.push(vm.orderedTiles.map((t) => t.id));
          seriesPoints += vm.points;
        }
      }
    }

    // Only return melds and points that are ACTUALLY arranged (dizili) on the rack
    return {
      seriesMelds,
      seriesPoints,
      pairMelds,
      pairCount: pairMelds.length
    };
  }

  function reconcileRackAndStaged() {
    const validIds = new Set(privateRack.map((t) => t.id));

    const stagedSet = new Set();
    stagedGroups = stagedGroups.map((group) =>
      group.filter((id) => {
        if (validIds.has(id) && !stagedSet.has(id)) {
          stagedSet.add(id);
          return true;
        }
        return false;
      })
    );
    if (stagedGroups.length === 0) stagedGroups = [[]];
    if (activeStagedGroupIdx >= stagedGroups.length) {
      activeStagedGroupIdx = stagedGroups.length - 1;
    }

    const placedInRack = new Set();
    for (let i = 0; i < RACK_SLOTS_TOTAL; i++) {
      const id = rackSlots[i];
      if (id != null && validIds.has(id) && !stagedSet.has(id) && !placedInRack.has(id)) {
        placedInRack.add(id);
      } else {
        rackSlots[i] = null;
      }
    }

    for (const tile of privateRack) {
      if (!stagedSet.has(tile.id) && !placedInRack.has(tile.id)) {
        // Place newly drawn / unused tiles at the trailing end of Row 1,
        // or if Row 1 is full, at the far right end of Row 0 (slot 13 going left).
        let targetSlot = -1;
        let lastOccRow1 = -1;
        for (let i = 14; i < 28; i++) {
          if (rackSlots[i] != null) lastOccRow1 = i;
        }
        if (lastOccRow1 === -1) {
          targetSlot = 14;
        } else if (lastOccRow1 + 1 < 28 && rackSlots[lastOccRow1 + 1] == null) {
          targetSlot = lastOccRow1 + 1;
        } else {
          // Place at the right end of the upper row (Row 0: slot 13 down to 0)
          for (let i = 13; i >= 0; i--) {
            if (rackSlots[i] == null) {
              targetSlot = i;
              break;
            }
          }
          if (targetSlot === -1) {
            targetSlot = rackSlots.lastIndexOf(null);
          }
        }
        if (targetSlot !== -1) {
          rackSlots[targetSlot] = tile.id;
          placedInRack.add(tile.id);
        }
      }
    }

    if (selectedTileId != null && !validIds.has(selectedTileId)) {
      selectedTileId = null;
    }
  }

  function getTileById(tileId) {
    return privateRack.find((t) => t.id === tileId) || null;
  }

  // ---------------------------------------------------------------------------
  // Sending Player Intents
  // ---------------------------------------------------------------------------
  function dispatchIntent(intent) {
    hideAlert();
    if (role === 'host') {
      if (!hostState) return { ok: false, reason: 'No host state.' };
      const prevTurn = hostState.currentTurn;
      const prevPhase = hostState.phase;
      const res = Engine.applyIntent(hostState, 0, intent);
      if (!res.ok) {
        showAlert(res.reason);
        return res;
      }
      if (hostState.phase === 'playing' && (hostState.currentTurn !== prevTurn || prevPhase !== 'playing')) {
        resetTurnTimer();
      }
      saveHostSession();
      syncAllSeats();
      scheduleBotIfNeeded();
      return res;
    } else {
      const sent = transport && transport.send(null, {
        v: 1,
        seq: clientSeq++,
        type: 'INTENT',
        intent
      });
      if (!sent) {
        showAlert('Not connected to host DataChannel.');
        return { ok: false, reason: 'DataChannel not open.' };
      }
      return { ok: true };
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering: Lobby Screen
  // ---------------------------------------------------------------------------
  function renderLobbySeats() {
    const container = $('lobby-seats-grid');
    if (!publicState) {
      container.innerHTML = '';
      return;
    }
    const fillBots = $('chk-fill-bots').checked;
    container.innerHTML = '';

    for (let s = 0; s < 4; s++) {
      const seatObj = publicState.seats[s];
      const isYou = s === localSeat;
      const card = document.createElement('div');
      card.className = 'lobby-seat-card' + (isYou ? ' is-you' : '');

      let titleText = seatObj.name;
      let statusBadge = '';
      if (s === 0) {
        statusBadge = `<span class="badge badge-ok">${t('seatHost')}</span>`;
      } else if (seatObj.connected) {
        statusBadge = `<span class="badge badge-ok">${t('seatConnected')}</span>`;
      } else if (fillBots) {
        titleText = `${t('seatBot')} ${s + 1}`;
        statusBadge = `<span class="badge badge-warn">${t('seatBot')}</span>`;
      } else {
        titleText = t('seatEmpty');
        statusBadge = `<span class="badge badge-neutral">Waiting</span>`;
      }

      card.innerHTML = `
        <div>
          <div class="lobby-seat-title">Seat ${s + 1}: ${escapeHtml(titleText)} ${isYou ? `(${t('seatYou')})` : ''}</div>
          <div class="lobby-seat-sub">${s === 0 ? 'Room Creator' : (seatObj.connected ? 'Human Peer (WebRTC)' : (fillBots ? 'AI Bot (Auto-fill)' : 'Open Slot'))}</div>
        </div>
        <div>${statusBadge}</div>
      `;
      container.appendChild(card);
    }
  }

  $('chk-fill-bots').addEventListener('change', renderLobbySeats);

  // ---------------------------------------------------------------------------
  // Rendering: Tile Element Builder
  // ---------------------------------------------------------------------------
  function createTileElement(tile, indicator, opts) {
    const options = opts || {};
    const el = document.createElement('div');
    if (!tile) return el;

    const isWild = indicator ? Engine.isOkeyTile(tile, indicator) : false;
    const eff = indicator ? Engine.getEffectiveTile(tile, indicator) : {
      color: tile.color || 'black',
      number: tile.number || '★'
    };

    const colorCls = `tile-color-${eff.color || 'black'}`;
    el.className = `okey-tile ${colorCls}` +
      (options.small ? ' tile-sm' : '') +
      (options.felt ? ' tile-felt' : '') +
      (options.isIsleTile ? ' is-isle-tile' : '') +
      (options.animClass ? ` ${options.animClass}` : '') +
      (isWild ? ' is-wild-okey' : '') +
      (tile.isFakeJoker ? ' is-fake-joker' : '') +
      (selectedTileId === tile.id ? ' selected' : '') +
      ((mustOpenWithTileId === tile.id || takenDiscardTileId === tile.id) ? ' must-use' : '');
    el.dataset.tileId = String(tile.id);

    if (isWild) {
      // Real Okey is flipped backwards (blank white tile back, only shows red dot if isle-eligible)
      el.innerHTML = `<span class="tile-num"></span><span class="tile-dot"></span>`;
      return el;
    }

    const numText = tile.isFakeJoker ? '♣' : String(tile.number);

    el.innerHTML = `
      <span class="tile-num">${escapeHtml(numText)}</span>
      <span class="tile-dot"></span>
    `;
    return el;
  }

  // ---------------------------------------------------------------------------
  // Rendering: Classic 101 Okey Table Screen (Matching Reference Screenshot)
  // ---------------------------------------------------------------------------
  function getRemainingTurnSeconds() {
    if (!publicState || publicState.phase !== 'playing' || !publicState.turnDeadlineMs) {
      return null;
    }
    return Math.max(0, Math.ceil((publicState.turnDeadlineMs - Date.now()) / 1000));
  }

  function getOpenedDisplayScore(seatObj) {
    if (!seatObj || !seatObj.openedMode) return null;
    if (seatObj.openedScore != null) return String(seatObj.openedScore);
    return seatObj.openedMode === 'pairs' ? '55' : '101';
  }

  function renderTimerBadge() {
    if (!publicState) return;
    const rem = getRemainingTurnSeconds();
    const txt = rem != null ? `${rem}s` : '';
    const mySeat = localSeat != null ? localSeat : 0;
    const isMyTurn = publicState.phase === 'playing' && publicState.currentTurn === mySeat;
    const mySeatObj = publicState.seats[mySeat];
    const myOpenedStr = getOpenedDisplayScore(mySeatObj);

    const localTimerEl = $('hud-timer-badge');
    if (localTimerEl) {
      localTimerEl.textContent = isMyTurn ? txt : '';
      localTimerEl.classList.toggle('hidden', !isMyTurn || !txt);
    }
    const localStatsBox = $('local-plaque-stats');
    if (localStatsBox) {
      localStatsBox.classList.toggle('hidden', !myOpenedStr && !(isMyTurn && txt));
    }

    document.querySelectorAll('.p-timer-text[data-seat]').forEach((el) => {
      const seatIdx = Number(el.dataset.seat);
      const isTurn = publicState.phase === 'playing' && publicState.currentTurn === seatIdx;
      el.textContent = isTurn ? txt : '';
      el.classList.toggle('hidden', !isTurn || !txt);
    });
  }

  function renderPlayerPlaquesAndCornerDiscards(ind, isMyTurn) {
    const mySeat = localSeat != null ? localSeat : 0;
    const rightSeat = (mySeat + 1) % 4;
    const topSeat = (mySeat + 2) % 4;
    const leftSeat = (mySeat + 3) % 4; // Previous player whose discard is takeable!

    const rem = getRemainingTurnSeconds();
    const timerTxt = rem != null ? `${rem}s` : '';

    // 1. Bottom Plaque (Local Player — YOU)
    const me = publicState.seats[mySeat];
    const meOpenedStr = getOpenedDisplayScore(me);
    $('local-turn-dome').classList.toggle('active', isMyTurn);
    $('plaque-bottom').classList.toggle('active-seat-glow', isMyTurn);
    $('local-plaque-name').textContent = me.name;
    if ($('local-plaque-score')) {
      $('local-plaque-score').textContent = '';
      $('local-plaque-score').classList.add('hidden');
    }
    const localOpenedEl = $('local-plaque-opened');
    if (localOpenedEl) {
      localOpenedEl.textContent = meOpenedStr || '';
      localOpenedEl.classList.toggle('hidden', !meOpenedStr);
    }
    const localTimerEl = $('hud-timer-badge');
    if (localTimerEl) {
      localTimerEl.textContent = isMyTurn ? timerTxt : '';
      localTimerEl.classList.toggle('hidden', !isMyTurn || !timerTxt);
    }
    const localStatsBox = $('local-plaque-stats');
    if (localStatsBox) {
      localStatsBox.classList.toggle('hidden', !meOpenedStr && !(isMyTurn && timerTxt));
    }

    // 2. Top Plaque (Across Player: topSeat)
    const topP = publicState.seats[topSeat];
    const topActive = publicState.phase === 'playing' && publicState.currentTurn === topSeat;
    const topOpenedStr = getOpenedDisplayScore(topP);
    const plaqueTop = $('plaque-top');
    plaqueTop.className = 'wood-plaque plaque-top' + (topActive ? ' active-seat-glow' : '');
    const showTopBox = Boolean(topOpenedStr || (topActive && timerTxt));
    plaqueTop.innerHTML = `
      <div class="avatar-box">${AVATARS[topSeat]}</div>
      <div class="v-name-text" style="font-size:10px;max-width:54px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(topP.name)}</div>
      <div class="p-score-box ${showTopBox ? '' : 'hidden'}">
        ${topOpenedStr ? `<div>${topOpenedStr}</div>` : ''}
        <div class="p-timer-text ${topActive && timerTxt ? '' : 'hidden'}" data-seat="${topSeat}">${topActive ? timerTxt : ''}</div>
      </div>
    `;

    // 3. Left Vertical Plaque (Previous Player: leftSeat)
    const leftP = publicState.seats[leftSeat];
    const leftActive = publicState.phase === 'playing' && publicState.currentTurn === leftSeat;
    const leftOpenedStr = getOpenedDisplayScore(leftP);
    const showLeftBox = Boolean(leftOpenedStr || (leftActive && timerTxt));
    const plaqueLeft = $('plaque-left');
    plaqueLeft.className = 'wood-plaque plaque-vertical plaque-left' + (leftActive ? ' active-seat-glow' : '');
    plaqueLeft.innerHTML = `
      <div class="v-stats-box ${showLeftBox ? '' : 'hidden'}">
        ${leftOpenedStr ? `<div>${leftOpenedStr}</div>` : ''}
        <div class="p-timer-text ${leftActive && timerTxt ? '' : 'hidden'}" data-seat="${leftSeat}">${leftActive ? timerTxt : ''}</div>
      </div>
      <div class="v-name-wrap">
        <span class="v-name-text">${escapeHtml(leftP.name)}</span>
      </div>
      <div class="avatar-box">${AVATARS[leftSeat]}</div>
    `;

    // 4. Right Vertical Plaque (Next Player: rightSeat)
    const rightP = publicState.seats[rightSeat];
    const rightActive = publicState.phase === 'playing' && publicState.currentTurn === rightSeat;
    const rightOpenedStr = getOpenedDisplayScore(rightP);
    const showRightBox = Boolean(rightOpenedStr || (rightActive && timerTxt));
    const plaqueRight = $('plaque-right');
    plaqueRight.className = 'wood-plaque plaque-vertical plaque-right' + (rightActive ? ' active-seat-glow' : '');
    plaqueRight.innerHTML = `
      <div class="avatar-box">${AVATARS[rightSeat]}</div>
      <div class="v-name-wrap">
        <span class="v-name-text">${escapeHtml(rightP.name)}</span>
      </div>
      <div class="v-stats-box ${showRightBox ? '' : 'hidden'}">
        ${rightOpenedStr ? `<div>${rightOpenedStr}</div>` : ''}
        <div class="p-timer-text ${rightActive && timerTxt ? '' : 'hidden'}" data-seat="${rightSeat}">${rightActive ? timerTxt : ''}</div>
      </div>
    `;

    // 5. Four Corner Discard Piles
    // Top-Left corner = Across player's discard (topSeat)
    renderCornerDiscard($('discard-slot-top'), topP.discardPile, ind, false, false);
    // Top-Right corner = Right player's discard (rightSeat)
    renderCornerDiscard($('discard-slot-right'), rightP.discardPile, ind, false, false);
    // Bottom-Left corner = Left (Previous) player's discard (leftSeat) -> TAKEABLE on draw phase, or RETURNABLE after taking!
    const canTakeLeft = isMyTurn && publicState.turnPhase === 'draw' && leftP.discardPile.length > 0;
    const canReturnLeft = isMyTurn && publicState.turnPhase === 'act' && takenDiscardTileId != null;
    renderCornerDiscard($('discard-slot-left'), leftP.discardPile, ind, canTakeLeft, false, canReturnLeft);
    // Bottom-Right corner = YOUR discard pile (mySeat) -> DROP/TAP to discard on your act phase!
    const canDiscardBottom = isMyTurn && publicState.turnPhase === 'act' && mustOpenWithTileId == null;
    renderCornerDiscard($('discard-slot-bottom'), me.discardPile, ind, false, canDiscardBottom, false);
  }

  function renderCornerDiscard(slotEl, discardPile, ind, isTakeable, isDiscardTarget, isReturnTarget) {
    slotEl.innerHTML = '';
    slotEl.classList.toggle('takeable', Boolean(isTakeable));
    slotEl.classList.toggle('returnable', Boolean(isReturnTarget));
    slotEl.classList.toggle('discard-target-ready', Boolean(isDiscardTarget && selectedTileId != null));
    slotEl.onclick = null;
    slotEl.ondragover = null;
    slotEl.ondrop = null;

    const topTile = discardPile && discardPile.length > 0 ? discardPile[discardPile.length - 1] : null;
    if (topTile) {
      const animClass = (newlyDiscardedSeat != null && slotEl === getDiscardSlotElementForSeat(newlyDiscardedSeat))
        ? 'tile-anim-discard-land'
        : '';
      slotEl.appendChild(createTileElement(topTile, ind, { small: true, animClass }));
    } else if (isReturnTarget) {
      const hint = document.createElement('div');
      hint.className = 'return-discard-hint';
      hint.innerHTML = currentLang === 'en' ? '&#8617;<br>PUT BACK' : '&#8617;<br>GERİ BIRAK';
      slotEl.appendChild(hint);
    }

    if (isTakeable) {
      slotEl.onclick = () => dispatchIntent({ type: 'TAKE_DISCARD' });
    } else if (isReturnTarget) {
      slotEl.onclick = () => dispatchIntent({ type: 'RETURN_DISCARD' });
      slotEl.ondragover = (e) => e.preventDefault();
      slotEl.ondrop = (e) => {
        e.preventDefault();
        dispatchIntent({ type: 'RETURN_DISCARD' });
      };
    }

    if (isDiscardTarget) {
      slotEl.onclick = () => {
        if (selectedTileId != null) {
          const tid = selectedTileId;
          selectedTileId = null;
          dispatchIntent({ type: 'DISCARD', tileId: tid });
        }
      };
      slotEl.ondragover = (e) => e.preventDefault();
      slotEl.ondrop = (e) => {
        e.preventDefault();
        const draggedId = Number(e.dataTransfer.getData('text/plain'));
        if (draggedId) {
          selectedTileId = null;
          dispatchIntent({ type: 'DISCARD', tileId: draggedId });
        }
      };
    }
  }

  function renderGameView() {
    if (!publicState) return;
    const ind = publicState.indicator;
    const mySeat = localSeat != null ? localSeat : 0;
    const isMyTurn = publicState.phase === 'playing' && publicState.currentTurn === mySeat;
    const myPubSeat = publicState.seats[mySeat] || publicState.seats[0];

    // Status Banner & Round Label
    $('hud-round-badge').textContent = `${publicState.roundIndex + 1}/${publicState.totalRounds} ${t('roundSuffix')}`;
    const turnBanner = $('hud-turn-banner');
    if (publicState.phase === 'playing') {
      if (isMyTurn) {
        turnBanner.textContent = publicState.turnPhase === 'draw' ? t('yourTurnDraw') : t('yourTurnAct');
        turnBanner.className = 'turn-banner is-your-turn';
      } else {
        const activeName = publicState.seats[publicState.currentTurn].name;
        turnBanner.textContent = `${t('waitingTurn')} ${activeName}`;
        turnBanner.className = 'turn-banner';
      }
    } else if (publicState.phase === 'roundEnd') {
      turnBanner.textContent = t('roundEndTitle');
      turnBanner.className = 'turn-banner';
    } else if (publicState.phase === 'matchEnd') {
      const winSeat = publicState.matchWinnerSeat != null ? publicState.seats[publicState.matchWinnerSeat] : null;
      turnBanner.textContent = `${t('matchEndTitle')} ${winSeat ? winSeat.name : ''}`;
      turnBanner.className = 'turn-banner is-your-turn';
    }

    $('btn-next-round').classList.toggle('hidden', !(role === 'host' && publicState.phase === 'roundEnd'));

    // Render 4 Plaques & 4 Corner Discards
    renderPlayerPlaquesAndCornerDiscards(ind, isMyTurn);

    // Render Indicator, Active Okey helper, and Face-Down Stock Draw Pile
    const indSlot = $('indicator-tile-slot');
    indSlot.innerHTML = '';
    if (ind) indSlot.appendChild(createTileElement(ind, null, { small: true }));

    const okeySlot = $('okey-tile-slot');
    if (okeySlot) {
      okeySlot.innerHTML = '';
      if (publicState.okeySpec) {
        okeySlot.appendChild(createTileElement({
          id: -1,
          color: publicState.okeySpec.color,
          number: publicState.okeySpec.number,
          isFakeJoker: false
        }, ind, { small: true }));
      }
    }

    $('draw-pile-count').textContent = String(publicState.drawPileCount);

    const prevSeatIdx = (mySeat + 3) % 4;
    const prevSeatDiscardCount = publicState.seats[prevSeatIdx]
      ? publicState.seats[prevSeatIdx].discardPile.length
      : 0;
    const canReturnTaken = isMyTurn && publicState.turnPhase === 'act' && takenDiscardTileId != null;
    $('btn-draw-stock').disabled = !(isMyTurn && (publicState.turnPhase === 'draw' || canReturnTaken) && publicState.drawPileCount > 0);
    $('btn-take-discard').disabled = !(isMyTurn && publicState.turnPhase === 'draw' && prevSeatDiscardCount > 0);
    $('btn-return-discard').classList.toggle('hidden', !canReturnTaken);
    $('btn-discard-selected').disabled = !(isMyTurn && publicState.turnPhase === 'act' && selectedTileId != null && mustOpenWithTileId == null);

    // Render Green Felt Grid Board: Left panel = Runs/Sets, Right panel = Pairs
    const seriesList = $('table-melds-list');
    const pairsList = $('table-pairs-list');
    seriesList.innerHTML = '';
    pairsList.innerHTML = '';

    let tableSeriesPts = 0;
    let tablePairsPts = 0;

    for (const meld of (publicState.tableMelds || [])) {
      const cluster = document.createElement('div');
      cluster.className = 'meld-cluster';
      cluster.dataset.meldId = String(meld.id);
      cluster.title = `Meld #${meld.id} (${meld.points} pts) — Tap with a selected tile to lay off`;
      const tilesRow = document.createElement('div');
      tilesRow.className = 'meld-cluster-tiles';
      const isNewMeld = newlyOpenedMeldIds.has(meld.id);
      meld.tiles.forEach((tile, tIdx) => {
        let animClass = '';
        if (isNewMeld) animClass = 'tile-anim-meld-drop';
        else if (newlyLaidOffTileIds.has(tile.id)) animClass = 'tile-anim-laid-off';
        const tEl = createTileElement(tile, ind, { felt: true, animClass });
        if (isNewMeld) tEl.style.animationDelay = `${tIdx * 35}ms`;
        tilesRow.appendChild(tEl);
      });
      cluster.appendChild(tilesRow);

      cluster.addEventListener('click', () => {
        if (selectedTileId == null) return;
        dispatchIntent({
          type: 'LAY_OFF',
          meldId: meld.id,
          tileIds: [selectedTileId]
        });
      });
      cluster.addEventListener('dragover', (e) => e.preventDefault());
      cluster.addEventListener('drop', (e) => {
        e.preventDefault();
        const draggedId = Number(e.dataTransfer.getData('text/plain'));
        if (draggedId) {
          dispatchIntent({
            type: 'LAY_OFF',
            meldId: meld.id,
            tileIds: [draggedId]
          });
        }
      });

      if (meld.kind === 'pair') {
        tablePairsPts += meld.points;
        pairsList.appendChild(cluster);
      } else {
        tableSeriesPts += meld.points;
        seriesList.appendChild(cluster);
      }
    }

    // Analyze player's rack groups for the live points/penalty badge & ÇİFT AÇ / SERİ AÇ buttons
    const rackAnalysis = analyzeRackContiguousGroups();
    const pointsPillEl = $('rack-points-pill');
    if (pointsPillEl) {
      if (myPubSeat.openedMode !== null) {
        // Player has already opened their hand -> show their remaining hand penalty
        const mult = myPubSeat.openedMode === 'pairs' ? 2 : 1;
        const remainingPenalty = Engine.calculateHandTilePoints(privateRack, ind) * mult;
        pointsPillEl.textContent = String(remainingPenalty);
        pointsPillEl.classList.remove('ready-101');
      } else {
        const isPairsView = rackArrangeMode === 'pairs' || (rackAnalysis.pairCount >= 5 && rackAnalysis.seriesPoints < 101);
        if (isPairsView) {
          // Arranging pairs: 4 pairs or fewer -> show 0; 5 pairs or more -> show remaining hand tiles sum * 2
          if (rackAnalysis.pairCount <= 4) {
            pointsPillEl.textContent = '0';
            pointsPillEl.classList.remove('ready-101');
          } else {
            const pairTileIds = new Set(rackAnalysis.pairMelds.flat());
            const leftoverAfterPairs = privateRack.filter((t) => !pairTileIds.has(t.id));
            const remainingPairPenalty = Engine.calculateHandTilePoints(leftoverAfterPairs, ind) * 2;
            pointsPillEl.textContent = String(remainingPairPenalty);
            pointsPillEl.classList.add('ready-101');
          }
        } else {
          // Arranging series: show ONLY the points of the arranged (dizili) series on the rack
          pointsPillEl.textContent = String(rackAnalysis.seriesPoints);
          pointsPillEl.classList.toggle('ready-101', rackAnalysis.seriesPoints >= 101);
        }
      }
    }

    // Show red penalty text to the right of the wooden rack if the player received a penalty (işlek discard / Okey taken / Okey discard)
    const rackPenaltyEl = $('rack-penalty-badge');
    if (rackPenaltyEl) {
      const pen = myPubSeat.penaltyAdjust || 0;
      if (pen > 0) {
        rackPenaltyEl.textContent = `+${pen} CEZA`;
        rackPenaltyEl.classList.remove('hidden');
      } else {
        rackPenaltyEl.classList.add('hidden');
      }
    }

    // Compute all "İŞLE" (lay-off) eligible tiles in rack so their bottom dot grows red
    const islePlan = Engine.findIslePlan(privateRack, publicState.tableMelds || [], ind);

    // Enable/disable ÇİFT AÇ, SERİ AÇ, İŞLE
    const canAct = isMyTurn && publicState.turnPhase === 'act';
    $('btn-cift-ac').disabled = !canAct;
    $('btn-open-melds').disabled = !canAct;
    $('btn-isle').disabled = !(canAct && myPubSeat.openedMode !== null && islePlan.steps.length > 0);

    // Render Manual Staged Melds in Drawer + Two-Row Wooden Rack + Scoreboard
    renderStagedMelds(ind, isMyTurn, myPubSeat);
    renderRack(ind, islePlan.isleTileIds);
    renderScoreboard();
  }

  function renderStagedMelds(ind, isMyTurn, myPubSeat) {
    const container = $('staged-groups-container');
    if (!container) return;
    container.innerHTML = '';

    const nonEmptyTileGroups = [];

    stagedGroups.forEach((groupIds, idx) => {
      const box = document.createElement('div');
      const tiles = groupIds.map(getTileById).filter(Boolean);
      const validation = (ind && tiles.length >= 2) ? Engine.validateMeld(tiles, ind) : { valid: false };
      if (tiles.length > 0) nonEmptyTileGroups.push(tiles);

      box.className = 'staged-group-box' +
        (idx === activeStagedGroupIdx ? ' active-group' : '') +
        (validation.valid ? ' valid-group' : '');

      const tilesDiv = document.createElement('div');
      tilesDiv.className = 'staged-group-tiles';

      if (tiles.length === 0) {
        tilesDiv.innerHTML = '<span class="empty-hint">Tap/drag tiles</span>';
      } else {
        tiles.forEach((tile) => {
          const tileEl = createTileElement(tile, ind, { small: true });
          tileEl.addEventListener('click', (e) => {
            e.stopPropagation();
            returnStagedTileToRack(tile.id);
          });
          tilesDiv.appendChild(tileEl);
        });
      }

      const footer = document.createElement('div');
      footer.className = 'staged-group-footer';
      let statusLabel = `${tiles.length}t`;
      if (validation.valid) {
        statusLabel = validation.kind === 'pair' ? 'Pair ✓' : `${validation.points} pts ✓`;
      }
      footer.innerHTML = `<span>G${idx + 1}</span><span>${statusLabel}</span>`;

      box.appendChild(tilesDiv);
      box.appendChild(footer);

      box.addEventListener('click', () => {
        activeStagedGroupIdx = idx;
        if (selectedTileId != null && rackSlots.includes(selectedTileId)) {
          moveTileToStagedGroup(selectedTileId, idx);
          selectedTileId = null;
        }
        renderGameView();
      });

      container.appendChild(box);
    });

    const counterBadge = $('staged-counter-badge');
    if (!counterBadge) return;
    if (nonEmptyTileGroups.length === 0 || !ind) {
      const rackAnalysis = analyzeRackContiguousGroups();
      counterBadge.textContent = `${rackAnalysis.seriesPoints} / 101 pts`;
      counterBadge.className = 'badge ' + (rackAnalysis.seriesPoints >= 101 ? 'badge-ok' : 'badge-neutral');
      return;
    }

    const openCheck = Engine.validateOpening(nonEmptyTileGroups, ind);
    counterBadge.textContent = openCheck.mode === 'pairs'
      ? `${openCheck.pairCount || nonEmptyTileGroups.length} / 5 pairs`
      : `${openCheck.totalPoints || 0} / 101 pts`;
    counterBadge.className = 'badge ' + (openCheck.valid ? 'badge-ok' : 'badge-warn');
  }

  function moveTileToStagedGroup(tileId, groupIdx) {
    const slotIdx = rackSlots.indexOf(tileId);
    if (slotIdx !== -1) rackSlots[slotIdx] = null;
    stagedGroups.forEach((g) => {
      const i = g.indexOf(tileId);
      if (i !== -1) g.splice(i, 1);
    });
    if (!stagedGroups[groupIdx]) stagedGroups[groupIdx] = [];
    stagedGroups[groupIdx].push(tileId);
  }

  function returnStagedTileToRack(tileId) {
    stagedGroups.forEach((g) => {
      const i = g.indexOf(tileId);
      if (i !== -1) g.splice(i, 1);
    });
    if (!rackSlots.includes(tileId)) {
      const emptyIdx = rackSlots.indexOf(null);
      if (emptyIdx !== -1) rackSlots[emptyIdx] = tileId;
    }
    renderGameView();
  }

  function renderRack(ind, isleTileIds) {
    const row0 = $('rack-row-0');
    const row1 = $('rack-row-1');
    row0.innerHTML = '';
    row1.innerHTML = '';

    for (let slotIdx = 0; slotIdx < RACK_SLOTS_TOTAL; slotIdx++) {
      const slotEl = document.createElement('div');
      slotEl.className = 'rack-slot';
      slotEl.dataset.slotIdx = String(slotIdx);

      const tileId = rackSlots[slotIdx];
      const tile = tileId != null ? getTileById(tileId) : null;

      if (tile) {
        const isIsleTile = Boolean(isleTileIds && isleTileIds.has(tile.id));
        const animClass = tile.id === newlyDrawnTileId ? 'tile-anim-newly-drawn' : '';
        const tileEl = createTileElement(tile, ind, { small: false, isIsleTile, animClass });
        tileEl.draggable = true;

        tileEl.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', String(tile.id));
          selectedTileId = tile.id;
        });

        tileEl.addEventListener('click', (e) => {
          e.stopPropagation();
          // Choosing two tiles back-to-back simply switches selection to the newly clicked tile (never swaps them)
          if (selectedTileId === tile.id) {
            selectedTileId = null;
          } else {
            selectedTileId = tile.id;
          }
          renderGameView();
        });

        slotEl.appendChild(tileEl);
      } else {
        slotEl.addEventListener('click', () => {
          if (selectedTileId != null) {
            const oldRects = captureCurrentRackRects();
            const prevSlot = rackSlots.indexOf(selectedTileId);
            if (prevSlot !== -1) rackSlots[prevSlot] = null;
            stagedGroups.forEach((g) => {
              const i = g.indexOf(selectedTileId);
              if (i !== -1) g.splice(i, 1);
            });
            rackSlots[slotIdx] = selectedTileId;
            selectedTileId = null;
            renderGameView();
            playRackFLIP(oldRects, 220);
          }
        });
      }

      slotEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        slotEl.classList.add('drag-over');
      });
      slotEl.addEventListener('dragleave', () => {
        slotEl.classList.remove('drag-over');
      });
      slotEl.addEventListener('drop', (e) => {
        e.preventDefault();
        slotEl.classList.remove('drag-over');
        const draggedId = Number(e.dataTransfer.getData('text/plain'));
        if (!draggedId) return;
        const oldRects = captureCurrentRackRects();
        const fromSlot = rackSlots.indexOf(draggedId);
        stagedGroups.forEach((g) => {
          const i = g.indexOf(draggedId);
          if (i !== -1) g.splice(i, 1);
        });
        const existingAtTarget = rackSlots[slotIdx];
        if (fromSlot !== -1) {
          rackSlots[fromSlot] = existingAtTarget;
        } else if (existingAtTarget != null) {
          const empty = rackSlots.indexOf(null);
          if (empty !== -1) rackSlots[empty] = existingAtTarget;
        }
        rackSlots[slotIdx] = draggedId;
        selectedTileId = null;
        renderGameView();
        playRackFLIP(oldRects, 220);
      });

      if (slotIdx < 14) row0.appendChild(slotEl);
      else row1.appendChild(slotEl);
    }
  }

  function renderScoreboard() {
    const tbody = $('score-table-body');
    tbody.innerHTML = '';
    if (!publicState) return;

    const lastRound = publicState.roundHistory && publicState.roundHistory.length > 0
      ? publicState.roundHistory[publicState.roundHistory.length - 1]
      : null;
    const isEndScreen = publicState.phase === 'roundEnd' || publicState.phase === 'matchEnd';

    // Sort players 1st to 4th:
    // - Winner who finished their hand (-101) is always 1st
    // - Otherwise ordered by roundScore ascending (lowest points = 1st, most points in hand / 202 = 4th),
    //   breaking ties by totalScore ascending.
    const rankedSeats = publicState.seats.slice().sort((a, b) => {
      if (isEndScreen && lastRound && lastRound.winnerSeat != null) {
        if (a.seat === lastRound.winnerSeat) return -1;
        if (b.seat === lastRound.winnerSeat) return 1;
      }
      if (isEndScreen && a.roundScore !== b.roundScore) {
        return a.roundScore - b.roundScore;
      }
      if (isEndScreen && (a.rawHandPoints || 0) !== (b.rawHandPoints || 0)) {
        return (a.rawHandPoints || 0) - (b.rawHandPoints || 0);
      }
      if (a.totalScore !== b.totalScore) {
        return a.totalScore - b.totalScore;
      }
      return a.seat - b.seat;
    });

    rankedSeats.forEach((s, idx) => {
      const rank = idx + 1;
      const tr = document.createElement('tr');
      const roundStr = s.roundScore > 0 ? `+${s.roundScore}` : String(s.roundScore);
      tr.innerHTML = `
        <td>${rank}. ${escapeHtml(s.name)} ${s.seat === localSeat ? '★' : ''}</td>
        <td>${roundStr}</td>
        <td><strong>${s.totalScore}</strong></td>
      `;
      tbody.appendChild(tr);
    });

    const summaryEl = $('round-end-summary');
    const modalEl = $('round-results-modal');

    if (isEndScreen && lastRound) {
      let subtitle = '';
      if (lastRound.endReason === 'stock_exhausted') {
        subtitle = currentLang === 'en'
          ? `Round ${lastRound.roundIndex + 1}: Draw pile ran out — ranked from lowest to highest hand penalty.`
          : `${lastRound.roundIndex + 1}. El: Çekme destesi bitti — en az cezadan en çok cezaya sıralama.`;
      } else {
        const wName = publicState.seats[lastRound.winnerSeat]
          ? publicState.seats[lastRound.winnerSeat].name
          : `Seat ${lastRound.winnerSeat + 1}`;
        subtitle = currentLang === 'en'
          ? `Round ${lastRound.roundIndex + 1} Winner: ${wName} (Finished hand: ${publicState.seats[lastRound.winnerSeat].roundScore} pts)`
          : `${lastRound.roundIndex + 1}. Eli Bitiren: ${wName} (${publicState.seats[lastRound.winnerSeat].roundScore} puan)`;
      }
      summaryEl.textContent = subtitle;
      summaryEl.classList.remove('hidden');

      // Populate prominent 1st..4th Round Results Modal on the table
      if (modalEl) {
        modalEl.classList.remove('hidden');
        $('results-modal-title').textContent = publicState.phase === 'matchEnd'
          ? (currentLang === 'en' ? 'Match Complete — Final Standings (1st to 4th)' : 'Oyun Bitti — Puan Sıralaması (1. - 4.)')
          : (currentLang === 'en' ? `Round ${lastRound.roundIndex + 1} / ${publicState.totalRounds} Standings` : `${lastRound.roundIndex + 1} / ${publicState.totalRounds} El Sonucu — Puan Sıralaması`);
        $('results-modal-subtitle').textContent = subtitle;

        // When totalRounds > 1 and an intermediate round finishes (phase === 'roundEnd'):
        // Do NOT ask players to accept/decline — show a 5-second automatic countdown timer to the next round.
        // When totalRounds === 1 (or when all rounds of the match have finished, phase === 'matchEnd'):
        // Ask the players if they want to play again in the same lobby (Accept / Decline).
        const isAutoCountdownBetweenRounds = publicState.totalRounds > 1 && publicState.phase === 'roundEnd';
        const newRoundHeaderTh = document.querySelector('.results-ranking-table th:nth-child(6)');
        if (newRoundHeaderTh) {
          newRoundHeaderTh.classList.toggle('hidden', isAutoCountdownBetweenRounds);
        }

        const rBody = $('results-ranking-body');
        rBody.innerHTML = '';
        rankedSeats.forEach((s, idx) => {
          const rank = idx + 1;
          const tr = document.createElement('tr');
          if (rank === 1) tr.className = 'results-row-winner';
          else if (rank === 4) tr.className = 'results-row-last';

          let statusText = '';
          if (lastRound.winnerSeat === s.seat) {
            statusText = currentLang === 'en' ? 'Finished Hand (-101)' : 'El Bitirdi (-101)';
          } else if (s.openedMode === null) {
            statusText = currentLang === 'en' ? 'Unopened (202)' : 'El Açmadı (202)';
          } else {
            statusText = currentLang === 'en'
              ? `Opened (${s.tileCount} tiles left)`
              : `Açtı (${s.tileCount} taş kaldı)`;
          }

          const roundPtsStr = s.roundScore > 0 ? `+${s.roundScore}` : String(s.roundScore);
          const totalPtsStr = s.totalScore > 0 ? `+${s.totalScore}` : String(s.totalScore);

          let readyCellHtml = '';
          if (!isAutoCountdownBetweenRounds) {
            let readyBadgeHtml = '';
            if (s.isBot) {
              readyBadgeHtml = `<span class="ready-pill bot">🤖 Bot (Hazır)</span>`;
            } else if (s.readyNext === 'accepted') {
              readyBadgeHtml = `<span class="ready-pill accepted">✓ ${currentLang === 'en' ? 'Accepted' : 'Kabul Etti'}</span>`;
            } else {
              readyBadgeHtml = `<span class="ready-pill waiting">⏳ ${currentLang === 'en' ? 'Waiting' : 'Bekleniyor'}</span>`;
            }
            readyCellHtml = `<td>${readyBadgeHtml}</td>`;
          }

          tr.innerHTML = `
            <td><span class="rank-badge rank-${rank}">${rank}</span></td>
            <td>${AVATARS[s.seat] || ''} ${escapeHtml(s.name)} ${s.seat === localSeat ? `(${t('seatYou')})` : ''}</td>
            <td>${escapeHtml(statusText)}</td>
            <td>${roundPtsStr}</td>
            <td>${totalPtsStr}</td>
            ${readyCellHtml}
          `;
          rBody.appendChild(tr);
        });

        const acceptBtn = $('btn-accept-next');
        const declineBtn = $('btn-decline-next');
        const modalNextBtn = $('btn-modal-next-round');
        const waitHint = $('results-guest-wait');

        if (isAutoCountdownBetweenRounds) {
          if (acceptBtn) acceptBtn.classList.add('hidden');
          if (declineBtn) declineBtn.classList.add('hidden');
          if (modalNextBtn) modalNextBtn.classList.add('hidden');
          $('btn-next-round').classList.add('hidden');
          startAutoNextRoundCountdown(lastRound.roundIndex);
        } else {
          clearAutoNextRoundCountdown();
          const mySeatObj = publicState.seats[localSeat != null ? localSeat : 0];
          const iAccepted = mySeatObj && mySeatObj.readyNext === 'accepted';

          if (acceptBtn) {
            acceptBtn.classList.remove('hidden');
            acceptBtn.textContent = iAccepted
              ? (currentLang === 'en' ? '✓ Accepted (Waiting for others...)' : '✓ Kabul Edildi (Diğerleri bekleniyor...)')
              : (currentLang === 'en' ? 'Play Again (Accept)' : 'Tekrar Oyna (Kabul Et)');
            acceptBtn.disabled = Boolean(iAccepted);
          }
          if (declineBtn) {
            declineBtn.classList.remove('hidden');
            declineBtn.textContent = currentLang === 'en' ? 'Decline & Leave' : 'Reddet & Ayrıl';
          }

          const someoneStillWaiting = publicState.seats.some((s) => !s.isBot && s.connected && s.readyNext !== 'accepted');
          if (modalNextBtn) {
            modalNextBtn.textContent = currentLang === 'en'
              ? 'Replace Waiting with Bots & Start'
              : 'Bekleyenleri Bot Yap & Başlat';
            modalNextBtn.classList.toggle('hidden', !(role === 'host' && iAccepted && someoneStillWaiting));
          }
          if (waitHint) {
            waitHint.textContent = currentLang === 'en'
              ? 'When all players respond, the new round starts automatically (declining seats become Bots).'
              : 'Tüm oyuncular yanıtladığında yeni el otomatik başlar (reddedenlerin yerine Bot geçer).';
            waitHint.classList.remove('hidden');
          }
        }
      }
    } else {
      clearAutoNextRoundCountdown();
      summaryEl.classList.add('hidden');
      if (modalEl) modalEl.classList.add('hidden');
    }
  }

  function clearAutoNextRoundCountdown() {
    clearTimeout(autoNextRoundTimer);
    clearInterval(autoNextRoundCountdownInterval);
    autoNextRoundTimer = null;
    autoNextRoundCountdownInterval = null;
    autoNextRoundScheduledForRound = -1;
  }

  function startAutoNextRoundCountdown(completedRoundIdx) {
    const waitHint = $('results-guest-wait');
    if (autoNextRoundScheduledForRound === completedRoundIdx) return;
    clearAutoNextRoundCountdown();
    autoNextRoundScheduledForRound = completedRoundIdx;

    let secondsLeft = 5;
    const updateLabel = () => {
      if (!waitHint) return;
      waitHint.classList.remove('hidden');
      waitHint.textContent = currentLang === 'en'
        ? `Next round (${completedRoundIdx + 2} / ${publicState ? publicState.totalRounds : ''}) starting in ${secondsLeft}s...`
        : `Sonraki el (${completedRoundIdx + 2} / ${publicState ? publicState.totalRounds : ''}) ${secondsLeft} saniye içinde başlıyor...`;
    };
    updateLabel();

    autoNextRoundCountdownInterval = setInterval(() => {
      secondsLeft = Math.max(0, secondsLeft - 1);
      updateLabel();
    }, 1000);

    if (role === 'host') {
      autoNextRoundTimer = setTimeout(() => {
        clearAutoNextRoundCountdown();
        if (hostState && hostState.phase === 'roundEnd') {
          dispatchIntent({ type: 'NEXT_ROUND', forceReplaceWaiting: false });
        }
      }, 5000);
    }
  }

  // ---------------------------------------------------------------------------
  // Diagnostics Panel Updater
  // ---------------------------------------------------------------------------
  function updateDiagnosticsUI(diag) {
    if (!diag) return;
    $('diag-adapter').textContent = diag.adapter || '-';
    const connected = diag.openPeerCount > 0 || (role === 'host' && publicState && publicState.phase !== 'lobby');
    $('diag-p2p-status').textContent = diag.pcState || '-';
    $('diag-p2p-status').className = diag.openPeerCount > 0 ? 'v-ok' : 'v-warn';
    $('diag-dc-status').textContent = diag.dcState || '-';
    $('diag-dc-status').className = diag.openPeerCount > 0 ? 'v-ok' : 'v-warn';
    $('diag-ping').textContent = diag.rttMs != null ? `${diag.rttMs} ms` : '-- ms';
    $('diag-peers').textContent = `${diag.openPeerCount} (${diag.txMessages} tx / ${diag.rxMessages} rx)`;
    $('diag-player-id').textContent = localSeat != null ? `Seat ${localSeat + 1} (${role || ''})` : '-';
    $('diag-room-code').textContent = roomCode || diag.roomCode || '-';
    $('diag-conn-type').textContent = diag.candidateSummary || diag.connectionType || '-';

    if (diag.signaling === 'connected') {
      setBadge($('signaling-badge'), t('signalingConnected'), 'badge-ok');
    } else if (diag.signaling === 'serverless-relays') {
      setBadge($('signaling-badge'), t('signalingServerless'), 'badge-ok');
    } else if (diag.signaling === 'connecting') {
      setBadge($('signaling-badge'), t('signalingConnecting'), 'badge-warn');
    } else {
      setBadge($('signaling-badge'), t('signalingOffline'), 'badge-bad');
    }

    const banner = $('diag-direct-banner');
    if (diag.openPeerCount > 0) {
      setBadge($('webrtc-badge'), t('p2pActive'), 'badge-ok');
      banner.textContent = diag.candidateSummary || 'Direct WebRTC P2P DataChannel ✓';
      banner.className = 'diag-direct-banner ok';
    } else if (roomCode) {
      setBadge($('webrtc-badge'), t('p2pLobby'), 'badge-warn');
      banner.textContent = connected ? 'Local Host Engine Active' : 'Waiting for WebRTC peers...';
      banner.className = 'diag-direct-banner';
    }
  }

  // ---------------------------------------------------------------------------
  // Button Event Listeners
  // ---------------------------------------------------------------------------
  $('btn-create-lobby').addEventListener('click', () => {
    hideAlert();
    clearSavedSessions();
    playerName = $('input-player-name').value.trim() || 'Alper';
    role = 'host';
    hostState = null;
    peerToSeat.clear();
    seatToPeer.clear();
    const tInst = initTransport(transportMode);
    tInst.createRoom();
  });

  const codeInput = $('input-room-code');
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    hideAlert();
    const code = codeInput.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      showAlert('Room codes are 6 characters long.');
      return;
    }
    playerName = $('input-player-name').value.trim() || 'Misafir';
    role = 'guest';
    roomCode = code;
    localSeatToken = getStoredSeatToken(code);
    const tInst = initTransport(transportMode);
    tInst.joinRoom(code, { rejoinToken: localSeatToken });
  });

  $('btn-copy-code').addEventListener('click', async () => {
    if (!roomCode) return;
    await copyTextToClipboard(roomCode);
    $('btn-copy-code').textContent = t('copiedText');
    setTimeout(() => { $('btn-copy-code').textContent = t('copyCodeBtn'); }, 1400);
  });

  $('btn-copy-link').addEventListener('click', async () => {
    if (!roomCode) return;
    const base = shareableBaseUrl || (location.origin + location.pathname);
    const query = transportMode === 'localws' ? '?transport=localws' : '';
    const link = `${base.replace(/\/$/, '')}/${query}#${roomCode}`;
    await copyTextToClipboard(link);
    $('btn-copy-link').textContent = t('copiedText');
    setTimeout(() => { $('btn-copy-link').textContent = t('copyLinkBtn'); }, 1400);
  });

  $('btn-start-game').addEventListener('click', () => {
    if (role !== 'host' || !hostState) return;
    const botNames = ['Alper', 'Gamze', 'Zeynep', 'Mert'];
    const fillBots = $('chk-fill-bots').checked;
    for (let s = 1; s < 4; s++) {
      if (!hostState.seats[s].connected) {
        if (!fillBots) {
          showAlert('Wait for all 4 players to connect or check "Fill empty seats with bots".');
          return;
        }
        hostState.seats[s].isBot = true;
        hostState.seats[s].connected = true;
        hostState.seats[s].name = botNames[s] || `${t('seatBot')} ${s + 1}`;
      }
    }
    Engine.startRound(hostState, 0);
    resetTurnTimer();
    saveHostSession();
    syncAllSeats();
    startHostTimers();
  });

  $('btn-cancel-waiting').addEventListener('click', () => leaveToMenu());
  $('btn-leave-game').addEventListener('click', () => leaveToMenu('You left the game.'));

  function leaveToMenu(infoMessage) {
    clearTimeout(botTimer);
    clearInterval(turnTickTimer);
    clearAutoNextRoundCountdown();
    if (role === 'guest' && transport) {
      transport.send(null, { v: 1, seq: clientSeq++, type: 'GUEST_LEAVE' });
    }
    if (transport) {
      transport.close(true);
      transport = null;
    }
    clearSavedSessions();
    hostState = null;
    publicState = null;
    privateRack = [];
    lastArrangedDealKey = null;
    rackArrangeMode = 'runs';
    roomCode = null;
    localSeat = null;
    peerToSeat.clear();
    seatToPeer.clear();
    setPauseBanner(false);
    setBadge($('webrtc-badge'), t('p2pIdle'), 'badge-neutral');
    showScreen('menu');
    if (infoMessage) showAlert(infoMessage, 'info');
  }

  // Gameplay action buttons
  $('btn-draw-stock').addEventListener('click', () => {
    if (publicState && publicState.turnPhase === 'act' && takenDiscardTileId != null) {
      // Automatically put back the taken discard and draw from the center pile
      dispatchIntent({ type: 'RETURN_DISCARD' });
    }
    dispatchIntent({ type: 'DRAW_STOCK' });
  });

  $('btn-take-discard').addEventListener('click', () => {
    dispatchIntent({ type: 'TAKE_DISCARD' });
  });

  $('btn-return-discard').addEventListener('click', () => {
    dispatchIntent({ type: 'RETURN_DISCARD' });
  });

  $('btn-discard-selected').addEventListener('click', () => {
    if (selectedTileId == null) {
      showAlert('Tap a tile in your rack to select it before discarding.');
      return;
    }
    const tid = selectedTileId;
    selectedTileId = null;
    dispatchIntent({ type: 'DISCARD', tileId: tid });
  });

  // SERİ AÇ (Open Series — from manual staged groups OR rack contiguous/auto groups)
  $('btn-open-melds').addEventListener('click', () => {
    const manualNonEmpty = stagedGroups.filter((g) => g.length >= 2);
    let meldsToSubmit = manualNonEmpty;
    if (meldsToSubmit.length === 0) {
      const analysis = analyzeRackContiguousGroups();
      meldsToSubmit = analysis.seriesMelds;
    }
    if (!meldsToSubmit || meldsToSubmit.length === 0) {
      showAlert('No valid runs/sets (3+ tiles) found on your rack.');
      return;
    }
    const res = dispatchIntent({ type: 'OPEN_MELDS', melds: meldsToSubmit });
    if (res && res.ok) {
      stagedGroups = [[]];
      activeStagedGroupIdx = 0;
      renderGameView();
    }
  });

  // ÇİFT AÇ (Open Pairs — from manual staged groups OR rack pairs)
  $('btn-cift-ac').addEventListener('click', () => {
    const manualNonEmpty = stagedGroups.filter((g) => g.length === 2);
    let pairsToSubmit = manualNonEmpty;
    if (pairsToSubmit.length === 0) {
      const analysis = analyzeRackContiguousGroups();
      pairsToSubmit = analysis.pairMelds;
    }
    if (!pairsToSubmit || pairsToSubmit.length === 0) {
      showAlert('No valid pairs found on your rack.');
      return;
    }
    const res = dispatchIntent({ type: 'OPEN_MELDS', melds: pairsToSubmit });
    if (res && res.ok) {
      stagedGroups = [[]];
      activeStagedGroupIdx = 0;
      renderGameView();
    }
  });

  // İŞLE (Lay Off — lays off ALL eligible "işle" tiles from the player's rack onto table melds)
  $('btn-isle').addEventListener('click', () => {
    if (!publicState || !publicState.indicator) return;
    const ind = publicState.indicator;
    const islePlan = Engine.findIslePlan(privateRack, publicState.tableMelds || [], ind);
    if (!islePlan.steps || islePlan.steps.length === 0) {
      showAlert('No matching table meld found for lay-off.');
      return;
    }
    selectedTileId = null;
    for (const step of islePlan.steps) {
      const res = dispatchIntent({
        type: 'LAY_OFF',
        meldId: step.meldId,
        tileIds: [step.tileId]
      });
      if (res && res.ok === false) break;
    }
  });

  // SERİ DİZ (Sort Runs with gaps on the 2-row wooden rack + FLIP slide animation)
  $('btn-sort-runs').addEventListener('click', () => {
    const oldRects = captureCurrentRackRects();
    rackArrangeMode = 'runs';
    autoArrangeRackWithGaps('runs');
    renderGameView();
    playRackFLIP(oldRects, 300);
  });

  // ÇİFT DİZ (Sort Pairs/Sets with gaps on the 2-row wooden rack + FLIP slide animation)
  $('btn-sort-sets').addEventListener('click', () => {
    const oldRects = captureCurrentRackRects();
    rackArrangeMode = 'pairs';
    autoArrangeRackWithGaps('sets');
    renderGameView();
    playRackFLIP(oldRects, 300);
  });

  $('btn-new-meld-group').addEventListener('click', () => {
    stagedGroups.push([]);
    activeStagedGroupIdx = stagedGroups.length - 1;
    renderGameView();
  });

  $('btn-clear-staged').addEventListener('click', () => {
    const allIds = stagedGroups.flat();
    stagedGroups = [[]];
    activeStagedGroupIdx = 0;
    for (const id of allIds) {
      if (!rackSlots.includes(id)) {
        const empty = rackSlots.indexOf(null);
        if (empty !== -1) rackSlots[empty] = id;
      }
    }
    renderGameView();
  });

  $('btn-auto-group').addEventListener('click', () => {
    autoArrangeRackWithGaps('runs');
    renderGameView();
  });

  $('btn-next-round').addEventListener('click', () => {
    dispatchIntent({ type: 'NEXT_ROUND', forceReplaceWaiting: true });
  });
  if ($('btn-modal-next-round')) {
    $('btn-modal-next-round').addEventListener('click', () => {
      dispatchIntent({ type: 'NEXT_ROUND', forceReplaceWaiting: true });
    });
  }
  if ($('btn-accept-next')) {
    $('btn-accept-next').addEventListener('click', () => {
      dispatchIntent({ type: 'READY_NEXT', accept: true });
    });
  }
  if ($('btn-decline-next')) {
    $('btn-decline-next').addEventListener('click', () => {
      if (role === 'guest') {
        dispatchIntent({ type: 'READY_NEXT', accept: false });
        setTimeout(() => leaveToMenu('You left the table; a Bot took your seat for the remaining players.'), 120);
      } else {
        leaveToMenu('You closed the table.');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Utilities & Boot
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (__) {}
      ta.remove();
    }
  }

  fetch('/api/server-info').then((r) => r.json()).then((info) => {
    let url = location.origin;
    if ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') && info.lanAddresses && info.lanAddresses.length) {
      url = `${location.protocol}//${info.lanAddresses[0].address}:${location.port || info.port}`;
    }
    shareableBaseUrl = url;
    if ($('lan-url-display')) $('lan-url-display').textContent = url;
  }).catch(() => {
    shareableBaseUrl = location.origin + location.pathname;
    if ($('lan-url-display')) $('lan-url-display').textContent = shareableBaseUrl;
  });

  function boot() {
    applyLanguage('tr');
    const params = new URLSearchParams(location.search);
    const paramTransport = params.get('transport');
    if (paramTransport === 'localws' || paramTransport === 'trystero') {
      transportMode = paramTransport;
    } else {
      transportMode = 'trystero';
    }

    const hashCode = location.hash.replace(/^#/, '').trim().toUpperCase();
    if (/^[A-Z0-9]{6}$/.test(hashCode)) {
      codeInput.value = hashCode;
    }

    let activeSession = null;
    try {
      const raw = sessionStorage.getItem(ACTIVE_SESSION_KEY);
      if (raw) activeSession = JSON.parse(raw);
    } catch (_) {}

    if (activeSession && activeSession.role === 'host') {
      try {
        const savedHostRaw = localStorage.getItem(HOST_STORAGE_KEY);
        if (savedHostRaw) {
          const savedHost = JSON.parse(savedHostRaw);
          if (savedHost && savedHost.state && savedHost.roomCode === activeSession.roomCode) {
            role = 'host';
            roomCode = savedHost.roomCode;
            hostToken = savedHost.hostToken;
            playerName = savedHost.playerName || 'Alper';
            hostState = savedHost.state;
            for (let s = 1; s < 4; s++) {
              if (!hostState.seats[s].isBot) hostState.seats[s].connected = false;
            }
            const tInst = initTransport(savedHost.transportMode || transportMode);
            tInst.createRoom({ roomCode, hostToken });
            return;
          }
        }
      } catch (_) {}
    }

    if (activeSession && activeSession.role === 'guest' && activeSession.roomCode && activeSession.seatToken) {
      role = 'guest';
      roomCode = activeSession.roomCode;
      localSeatToken = activeSession.seatToken;
      playerName = activeSession.playerName || 'Misafir';
      setStoredSeatToken(roomCode, localSeatToken);
      const tInst = initTransport(activeSession.transportMode || transportMode);
      tInst.joinRoom(roomCode, { rejoinToken: localSeatToken });
      return;
    }

    showScreen('menu');
  }

  boot();

  window.__okeyGame = {
    Engine,
    get role() { return role; },
    get roomCode() { return roomCode; },
    get localSeat() { return localSeat; },
    get localSeatToken() { return localSeatToken; },
    get hostToken() { return hostToken; },
    get publicState() { return publicState; },
    get privateRack() { return privateRack; },
    get hostState() { return hostState; },
    get transport() { return transport; },
    get receivedMessages() { return receivedMessages; },
    setBotDelay(ms) { botDrawDelayMs = ms; botDiscardDelayMs = ms; },
    sendIntent: dispatchIntent,
    rejoinGuest(code, token, name, mode) {
      role = 'guest';
      roomCode = String(code).toUpperCase();
      localSeatToken = token;
      playerName = name || 'Rejoined Guest';
      setStoredSeatToken(roomCode, token);
      if (mode) transportMode = mode;
      const tInst = initTransport(transportMode);
      tInst.joinRoom(roomCode, { rejoinToken: token });
    }
  };
})();

/**
 * test/engine.test.js
 * Unit tests & Privacy tests for the 101 Okey engine (engine.js).
 *
 * Tests:
 * 1. 106-tile deck composition (104 numbered + 2 Fake Jokers) & deterministic seeded shuffle.
 * 2. Indicator -> Okey (number+1, 13 wraps to 1) and Fake Joker effective tile resolution.
 * 3. Runs and sets validation, including Okey wildcards and rejection of 12-13-1 wrap.
 * 4. 101-point opening, 5-pair opening, and rejection of mixed pairs + sets/runs.
 * 5. Taken-discard restriction for unopened players + return-discard rollback.
 * 6. Laying off onto table runs and sets.
 * 7. Pagat.com penalty & scoring table (Scenarios A, B, C, D, unplayed Okey = 101, mid-round Okey discard = +101, stock exhaustion).
 * 8. Full seeded 4-bot round reaching normal completion.
 * 9. PRIVACY TEST: records every message sent to each guest seat (1..3) during a full 4-player game
 *    and asserts that NO guest message ever contains another player's rack tiles, seatToken, or drawPile order.
 */
const Engine = require('../engine.js');

let passed = 0;
function assert(cond, name, extra) {
  if (!cond) {
    console.error(`FAIL: ${name}${extra ? ' — ' + extra : ''}`);
    process.exit(1);
  }
  passed++;
  console.log(`PASS: ${name}`);
}

// 1. Deck composition & deterministic shuffle
const deck = Engine.createDeck();
assert(deck.length === 106, 'Deck contains 106 tiles');
assert(deck.filter((t) => t.isFakeJoker).length === 2, 'Deck contains 2 Fake Jokers');
assert(deck.filter((t) => !t.isFakeJoker).length === 104, 'Deck contains 104 numbered tiles');

const shuf1 = Engine.shuffleDeck(deck, 'test-seed-42').map((t) => t.id).join(',');
const shuf2 = Engine.shuffleDeck(deck, 'test-seed-42').map((t) => t.id).join(',');
const shuf3 = Engine.shuffleDeck(deck, 'different-seed').map((t) => t.id).join(',');
assert(shuf1 === shuf2 && shuf1 !== shuf3, 'Shuffle is deterministic from seed');

// 2. Indicator -> Okey & Fake Joker resolution (including 13 -> 1 wrap)
const indRed13 = { id: 13, color: 'red', number: 13, isFakeJoker: false };
const okeySpec = Engine.getOkeySpec(indRed13);
assert(okeySpec.color === 'red' && okeySpec.number === 1, 'Indicator Red-13 wraps Okey to Red-1');

const realOkey = { id: 1, color: 'red', number: 1, isFakeJoker: false };
const fakeJoker = { id: 105, color: null, number: null, isFakeJoker: true };
assert(Engine.isOkeyTile(realOkey, indRed13) === true, 'Red-1 is recognized as wild Okey');
assert(Engine.isOkeyTile(fakeJoker, indRed13) === false, 'Fake Joker is NOT wild');
const effFJ = Engine.getEffectiveTile(fakeJoker, indRed13);
assert(!effFJ.isWild && effFJ.color === 'red' && effFJ.number === 1, 'Fake Joker stands in for Red-1');

// 3. Runs and sets validation & 12-13-1 rejection
const runValid = Engine.validateRun([
  { id: 10, color: 'blue', number: 10, isFakeJoker: false },
  realOkey, // wild standing in for Blue-11
  { id: 12, color: 'blue', number: 12, isFakeJoker: false }
], indRed13);
assert(runValid.valid && runValid.points === 33, 'Run with Okey in middle resolves to 10+11+12 = 33 pts');

const runWrapInvalid = Engine.validateRun([
  { id: 12, color: 'blue', number: 12, isFakeJoker: false },
  { id: 13, color: 'blue', number: 13, isFakeJoker: false },
  { id: 2, color: 'blue', number: 1, isFakeJoker: false }
], indRed13);
assert(!runWrapInvalid.valid, '12-13-1 wrap is rejected (1 is low only)');

const setValid = Engine.validateSet([
  { id: 20, color: 'red', number: 9, isFakeJoker: false },
  { id: 21, color: 'blue', number: 9, isFakeJoker: false },
  { id: 22, color: 'black', number: 9, isFakeJoker: false }
], indRed13);
assert(setValid.valid && setValid.points === 27, '3-color set of 9s validates to 27 pts');

const setDupColor = Engine.validateSet([
  { id: 20, color: 'red', number: 9, isFakeJoker: false },
  { id: 21, color: 'red', number: 9, isFakeJoker: false },
  { id: 22, color: 'black', number: 9, isFakeJoker: false }
], indRed13);
assert(!setDupColor.valid, 'Set with duplicate color is rejected');

// 4. 101-point opening, 5-pair opening, and no-mixing rule
const highRun1 = [
  { id: 31, color: 'yellow', number: 10, isFakeJoker: false },
  { id: 32, color: 'yellow', number: 11, isFakeJoker: false },
  { id: 33, color: 'yellow', number: 12, isFakeJoker: false },
  { id: 34, color: 'yellow', number: 13, isFakeJoker: false }
]; // 46 pts
const highRun2 = [
  { id: 41, color: 'black', number: 11, isFakeJoker: false },
  { id: 42, color: 'black', number: 12, isFakeJoker: false },
  { id: 43, color: 'black', number: 13, isFakeJoker: false }
]; // 36 pts (46+36 = 82 < 101)
const under101 = Engine.validateOpening([highRun1, highRun2], indRed13);
assert(!under101.valid && under101.totalPoints === 82, 'Opening under 101 points (82) is rejected');

const setOf7s = [
  { id: 51, color: 'red', number: 7, isFakeJoker: false },
  { id: 52, color: 'blue', number: 7, isFakeJoker: false },
  { id: 53, color: 'yellow', number: 7, isFakeJoker: false }
]; // 21 pts (82 + 21 = 103 >= 101)
const over101 = Engine.validateOpening([highRun1, highRun2, setOf7s], indRed13);
assert(over101.valid && over101.mode === 'sets' && over101.totalPoints === 103, 'Opening >= 101 points (103) succeeds');

const fivePairs = [
  [{ id: 61, color: 'red', number: 2 }, { id: 62, color: 'red', number: 2 }],
  [{ id: 63, color: 'blue', number: 3 }, { id: 64, color: 'blue', number: 3 }],
  [{ id: 65, color: 'yellow', number: 4 }, { id: 66, color: 'yellow', number: 4 }],
  [{ id: 67, color: 'black', number: 5 }, { id: 68, color: 'black', number: 5 }],
  [{ id: 69, color: 'red', number: 6 }, realOkey]
];
const pairsOpen = Engine.validateOpening(fivePairs, indRed13);
assert(pairsOpen.valid && pairsOpen.mode === 'pairs' && pairsOpen.pairCount === 5, 'Opening with 5 pairs (including wild Okey) succeeds');

const mixedOpen = Engine.validateOpening([fivePairs[0], highRun1], indRed13);
assert(!mixedOpen.valid && /mix/i.test(mixedOpen.reason), 'Mixing pairs and runs/sets in opening is rejected');

// 5. Taken-discard restriction for unopened player + lay-off test
const testState = Engine.createGameState({ roomCode: 'TEST01', seed: 'unit-seed-1', autoStart: true });
// Starter (seat 0) discards first tile
const firstDiscardId = testState.seats[0].rack[0].id;
assert(Engine.applyIntent(testState, 0, { type: 'DISCARD', tileId: firstDiscardId }).ok, 'Starter discards to end turn 1');
assert(testState.currentTurn === 1 && testState.turnPhase === 'draw', 'Turn advances to Seat 1 in draw phase');
assert(Engine.applyIntent(testState, 1, { type: 'TAKE_DISCARD' }).ok, 'Seat 1 takes Seat 0 discard');
assert(testState.seats[1].mustOpenWithTileId === firstDiscardId, 'Unopened Seat 1 is marked mustOpenWithTileId');
const illegalDiscard = Engine.applyIntent(testState, 1, { type: 'DISCARD', tileId: testState.seats[1].rack[0].id });
assert(!illegalDiscard.ok, 'Unopened player cannot discard without opening after taking discard');
assert(Engine.applyIntent(testState, 1, { type: 'RETURN_DISCARD' }).ok, 'Seat 1 returns taken discard');
assert(testState.turnPhase === 'draw' && testState.seats[0].discardPile.length === 1, 'Returned discard restored to Seat 0 discard pile');

// 6. Lay-off validation (Fake Joker + normal tile onto table run)
const tableRun = {
  id: 1,
  ownerSeat: 0,
  kind: 'run',
  tiles: [
    { id: 2, color: 'red', number: 2, isFakeJoker: false },
    { id: 3, color: 'red', number: 3, isFakeJoker: false },
    { id: 4, color: 'red', number: 4, isFakeJoker: false }
  ],
  points: 9
};
const layOffFJ = Engine.validateLayOff(tableRun, [fakeJoker], indRed13); // Fake Joker = Red 1
assert(layOffFJ.valid && layOffFJ.startNumber === 1 && layOffFJ.endNumber === 4, 'Fake Joker (Red-1) lays off cleanly onto start of Red 2-3-4 run');

// 6b. Okey (Joker) Retrieval test: Table meld is [Blue 8, Blue 9, Joker(Red 1), Blue 11], player lays Blue 10 -> gets Joker!
const jokerRunState = Engine.createGameState({ roomCode: 'JKR101', seed: 'jkr-seed', autoStart: true });
jokerRunState.indicator = indRed13;
jokerRunState.okeySpec = Engine.getOkeySpec(indRed13);
jokerRunState.currentTurn = 0;
jokerRunState.turnPhase = 'act';
jokerRunState.seats[0].openedMode = 'sets';
const blue10 = { id: 88, color: 'blue', number: 10, isFakeJoker: false };
const extraTile = { id: 89, color: 'black', number: 5, isFakeJoker: false };
jokerRunState.seats[0].rack = [blue10, extraTile];
jokerRunState.tableMelds = [{
  id: 1,
  ownerSeat: 1,
  kind: 'run',
  tiles: [
    { id: 81, color: 'blue', number: 8, isFakeJoker: false },
    { id: 82, color: 'blue', number: 9, isFakeJoker: false },
    realOkey, // standing in for Blue 10!
    { id: 84, color: 'blue', number: 11, isFakeJoker: false }
  ],
  points: 38
}];
const jkrIslePlan = Engine.findIslePlan(jokerRunState.seats[0].rack, jokerRunState.tableMelds, indRed13);
assert(jkrIslePlan.isleTileIds.has(blue10.id), 'Blue 10 gets red dot (isle-eligible) to retrieve Joker from 8-9-Joker-11');
const jkrLayRes = Engine.applyIntent(jokerRunState, 0, { type: 'LAY_OFF', meldId: 1, tileIds: [blue10.id] });
assert(
  jkrLayRes.ok &&
  jkrLayRes.retrievedOkey &&
  jkrLayRes.retrievedOkey.id === realOkey.id &&
  jokerRunState.seats[0].rack.some((t) => t.id === realOkey.id) &&
  jokerRunState.tableMelds[0].tiles[2].id === blue10.id,
  'Laying 10 onto [8, 9, Joker, 11] swaps 10 into the meld and gives the Joker to the player'
);

// 6c. Set Joker Retrieval rule: [Red 7, Yellow 7, Joker] + Blue 7 extends to 4 tiles (no retrieval);
//     then laying the 4th 7 (Black 7) onto [Red 7, Yellow 7, Joker, Blue 7] retrieves the Joker!
const set3WithJoker = {
  id: 2,
  ownerSeat: 1,
  kind: 'set',
  tiles: [
    { id: 71, color: 'red', number: 7, isFakeJoker: false },
    { id: 72, color: 'yellow', number: 7, isFakeJoker: false },
    realOkey
  ],
  points: 21
};
const blue7 = { id: 73, color: 'blue', number: 7, isFakeJoker: false };
const black7 = { id: 74, color: 'black', number: 7, isFakeJoker: false };
const extSetRes = Engine.validateLayOff(set3WithJoker, [blue7], indRed13);
assert(
  extSetRes.valid && !extSetRes.retrievedOkey && extSetRes.orderedTiles.length === 4,
  'Laying Blue 7 onto [Red 7, Yellow 7, Joker] extends to 4 tiles and does NOT retrieve the Joker'
);
const set4WithJoker = {
  id: 2,
  ownerSeat: 1,
  kind: 'set',
  tiles: extSetRes.orderedTiles,
  points: 28
};
const retrieveFrom4SetRes = Engine.validateLayOff(set4WithJoker, [black7], indRed13);
assert(
  retrieveFrom4SetRes.valid &&
  retrieveFrom4SetRes.retrievedOkey &&
  retrieveFrom4SetRes.retrievedOkey.id === realOkey.id &&
  retrieveFrom4SetRes.orderedTiles.length === 4,
  'Laying the 4th 7 (Black 7) onto [Red 7, Yellow 7, Joker, Blue 7] retrieves the Joker'
);

const islePlan = Engine.findIslePlan([
  fakeJoker, // Red 1 (fits start of Red 2-3-4)
  { id: 5, color: 'red', number: 5, isFakeJoker: false }, // fits end of Red 2-3-4
  { id: 6, color: 'red', number: 6, isFakeJoker: false }, // chains after Red 5!
  { id: 99, color: 'black', number: 11, isFakeJoker: false } // leftover tile to discard
], [tableRun], indRed13);
assert(
  islePlan.isleTileIds.has(105) && islePlan.isleTileIds.has(5) && islePlan.isleTileIds.has(6) && islePlan.steps.length === 3,
  'findIslePlan marks all direct and chained işle tiles with red dot and plans all 3 lay-offs'
);

// 7. Pagat.com Penalty & Scoring Table verification (Scenarios A, B, C, D + unplayed Okey = 101)
function testScoringScenario(wonWithPairs, wonWithOkey) {
  const st = Engine.createGameState({ roomCode: 'SCORE1', seed: 'score-seed', totalRounds: 1, autoStart: true });
  st.indicator = indRed13;
  st.okeySpec = Engine.getOkeySpec(indRed13);
  st.currentTurn = 0;
  st.turnPhase = 'act';
  // Seat 0: winner (1 tile left in rack to discard)
  st.seats[0].openedMode = wonWithPairs ? 'pairs' : 'sets';
  st.seats[0].rack = [wonWithOkey ? realOkey : { id: 90, color: 'blue', number: 5, isFakeJoker: false }];
  // Seat 1: unopened loser
  st.seats[1].openedMode = null;
  // Seat 2: opened with sets, holding 10 points + 1 unplayed Okey (10 + 101 = 111 base points)
  st.seats[2].openedMode = 'sets';
  st.seats[2].rack = [{ id: 91, color: 'blue', number: 10, isFakeJoker: false }, realOkey];
  // Seat 3: opened with pairs, holding 15 points
  st.seats[3].openedMode = 'pairs';
  st.seats[3].rack = [
    { id: 92, color: 'yellow', number: 7, isFakeJoker: false },
    { id: 93, color: 'black', number: 8, isFakeJoker: false }
  ];
  const res = Engine.applyIntent(st, 0, { type: 'DISCARD', tileId: st.seats[0].rack[0].id });
  assert(res.ok && res.roundEnded, `Round ends when Seat 0 discards last tile (pairs=${wonWithPairs}, okey=${wonWithOkey})`);
  return st.seats.map((s) => s.roundScore);
}

const scA = testScoringScenario(false, false);
assert(scA[0] === -101 && scA[1] === 202 && scA[2] === 111 && scA[3] === 30,
  `Scenario A scores match Pagat table: [${scA.join(', ')}]`);

const scB = testScoringScenario(false, true);
assert(scB[0] === -202 && scB[1] === 404 && scB[2] === 222 && scB[3] === 60,
  `Scenario B scores match Pagat table: [${scB.join(', ')}]`);

const scC = testScoringScenario(true, false);
assert(scC[0] === -202 && scC[1] === 404 && scC[2] === 222 && scC[3] === 60,
  `Scenario C scores match Pagat table: [${scC.join(', ')}]`);

const scD = testScoringScenario(true, true);
assert(scD[0] === -404 && scD[1] === 404 && scD[2] === 444 && scD[3] === 120,
  `Scenario D scores match Pagat table: [${scD.join(', ')}]`);

// 7b. End-of-round Play-Again voting in same lobby: 3 players accept, 1 declines -> declined seat replaced by Bot & new round starts
const rematchState = Engine.createGameState({
  roomCode: 'REMTCH',
  seed: 'rematch-seed',
  totalRounds: 2,
  seats: [
    { name: 'P1', connected: true },
    { name: 'P2', connected: true },
    { name: 'P3', connected: true },
    { name: 'P4', connected: true }
  ],
  autoStart: true
});
rematchState.currentTurn = 0;
rematchState.turnPhase = 'act';
rematchState.seats[0].openedMode = 'sets';
rematchState.seats[0].rack = [rematchState.seats[0].rack[0]];
assert(Engine.applyIntent(rematchState, 0, { type: 'DISCARD', tileId: rematchState.seats[0].rack[0].id }).ok, 'Round 1 ends');
assert(rematchState.phase === 'roundEnd', 'Game enters roundEnd phase');
assert(Engine.applyIntent(rematchState, 0, { type: 'READY_NEXT', accept: true }).ok, 'Player 1 (Host) accepts play again');
assert(Engine.applyIntent(rematchState, 1, { type: 'READY_NEXT', accept: true }).ok, 'Player 2 accepts play again');
assert(Engine.applyIntent(rematchState, 2, { type: 'READY_NEXT', accept: true }).ok, 'Player 3 accepts play again');
assert(rematchState.phase === 'roundEnd', 'Still waiting for Player 4 response');
const r4 = Engine.applyIntent(rematchState, 3, { type: 'READY_NEXT', accept: false });
assert(r4.ok && rematchState.phase === 'playing' && rematchState.roundIndex === 1,
  'Player 4 declines -> round 2 starts automatically in same lobby');
assert(rematchState.seats[3].isBot === true && !rematchState.seats[1].isBot && !rematchState.seats[2].isBot,
  'Declining Player 4 is replaced with a Bot while accepting Players 1-3 remain human');

// 8 & 9. Full seeded 4-bot round + PRIVACY TEST
const botGame = Engine.createGameState({
  roomCode: 'BOT101',
  seed: 'full-bot-round-2026',
  totalRounds: 1,
  seats: [
    { name: 'Bot 0', isBot: true },
    { name: 'Bot 1', isBot: true },
    { name: 'Bot 2', isBot: true },
    { name: 'Bot 3', isBot: true }
  ],
  autoStart: true
});

const guestMessageLog = { 1: [], 2: [], 3: [] };

function recordGuestMessages(state) {
  for (const guestSeat of [1, 2, 3]) {
    const msg = Engine.getStateSyncForSeat(state, guestSeat);
    guestMessageLog[guestSeat].push({
      rawJson: JSON.stringify(msg),
      msg,
      hiddenDrawPileIds: state.drawPile.map((t) => t.id),
      otherSeatRackIds: [0, 1, 2, 3]
        .filter((s) => s !== guestSeat)
        .flatMap((s) => state.seats[s].rack.map((t) => t.id)),
      otherSeatTokens: [0, 1, 2, 3]
        .filter((s) => s !== guestSeat)
        .map((s) => state.seats[s].seatToken)
    });
  }
}

recordGuestMessages(botGame);
let turnsPlayed = 0;
while (botGame.phase === 'playing' && turnsPlayed < 200) {
  const activeSeat = botGame.currentTurn;
  const r = Engine.runBotTurn(botGame, activeSeat);
  assert(r.ok, `Bot turn ${turnsPlayed + 1} (Seat ${activeSeat}) is legal`, r.reason);
  recordGuestMessages(botGame);
  turnsPlayed++;
}

assert(botGame.phase === 'matchEnd' && botGame.roundHistory.length === 1,
  `4-bot seeded round finished cleanly in ${turnsPlayed} turns (${botGame.roundHistory[0].endReason})`);

// Verify PRIVACY on every single recorded message across all 3 guests
let totalGuestMessagesChecked = 0;
for (const guestSeat of [1, 2, 3]) {
  for (const entry of guestMessageLog[guestSeat]) {
    totalGuestMessagesChecked++;
    const { msg, rawJson, hiddenDrawPileIds, otherSeatRackIds, otherSeatTokens } = entry;

    // 1. Public state must never have a drawPile array or any seat's rack or seatToken
    if (Array.isArray(msg.publicState.drawPile)) {
      assert(false, `Guest ${guestSeat} received drawPile array in publicState`);
    }
    for (const pubSeat of msg.publicState.seats) {
      if (pubSeat.rack !== undefined || pubSeat.seatToken !== undefined) {
        assert(false, `Guest ${guestSeat} publicState leaked rack or seatToken for seat ${pubSeat.seat}`);
      }
    }

    // 2. Collect every tile ID present anywhere in the message sent to guestSeat
    const visibleTileIds = new Set();
    if (msg.publicState.indicator) visibleTileIds.add(msg.publicState.indicator.id);
    for (const m of msg.publicState.tableMelds) {
      for (const t of m.tiles) visibleTileIds.add(t.id);
    }
    for (const s of msg.publicState.seats) {
      for (const t of s.discardPile) visibleTileIds.add(t.id);
    }
    if (msg.publicState.lastAction && msg.publicState.lastAction.tile) {
      visibleTileIds.add(msg.publicState.lastAction.tile.id);
    }
    for (const t of msg.privateRack.rack) {
      visibleTileIds.add(t.id);
    }

    // Assert zero overlap with any other player's private rack tiles
    for (const secretTileId of otherSeatRackIds) {
      if (visibleTileIds.has(secretTileId)) {
        assert(false, `PRIVACY VIOLATION: Guest ${guestSeat} received tile #${secretTileId} belonging to another player's rack`);
      }
    }

    // Assert zero overlap with any tile currently in the face-down draw pile
    for (const stockTileId of hiddenDrawPileIds) {
      if (visibleTileIds.has(stockTileId)) {
        assert(false, `PRIVACY VIOLATION: Guest ${guestSeat} received tile #${stockTileId} from the face-down draw pile`);
      }
    }

    // Assert no other seat's secret token appears anywhere in the serialized JSON
    for (const token of otherSeatTokens) {
      if (rawJson.includes(token)) {
        assert(false, `PRIVACY VIOLATION: Guest ${guestSeat} payload contained another player's seatToken`);
      }
    }
  }
}

assert(totalGuestMessagesChecked > 60,
  `PRIVACY TEST: Verified ${totalGuestMessagesChecked} guest STATE_SYNC messages — 0 opponent rack tiles, 0 draw-pile tiles, and 0 tokens leaked`);

console.log(`\nAll ${passed} engine & privacy checks passed.`);


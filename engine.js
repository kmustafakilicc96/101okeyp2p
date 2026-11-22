/**
 * engine.js
 * Pure, deterministic 101 Okey game engine (Zero DOM, Zero Network).
 * Compatible with both browser (<script src="/engine.js"> -> window.Okey101Engine)
 * and Node.js (const Okey101Engine = require('./engine.js')).
 *
 * Rules & Penalty Table source: https://www.pagat.com/rummy/okey101.html
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Okey101Engine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLORS = ['red', 'yellow', 'blue', 'black'];

  /**
   * Single authoritative scoring and rules configuration object.
   * All numeric values are cross-checked against Pagat.com Okey 101 rules:
   * https://www.pagat.com/rummy/okey101.html
   */
  const SCORING_CONFIG = Object.freeze({
    // Rule toggles
    ALLOW_HIGH_ACE: false,            // 1 is low only (1-2-3 valid; 12-13-1 invalid) [Pagat: "1 can only be used as the lowest tile"]
    ALLOW_OKEY_RETRIEVAL: true,       // Replacing a table Okey with the exact tile it represents gives the Okey to the player
    MIN_OPEN_POINTS: 101,             // Minimum total face value of sets/runs to open [Pagat: "at least 101"]
    MIN_OPEN_PAIRS: 5,                // Minimum number of pairs to open with doubles [Pagat: "at least five pairs"]
    DEFAULT_ROUNDS: 1,                // Default number of rounds per match (1 round standard)
    TURN_TIMEOUT_SEC: 60,             // Default turn timer enforced by host (60 seconds standard)

    // Tile & action penalties
    UNPLAYED_OKEY_HAND_VALUE: 101,    // Unplayed Okey left in hand at round end counts as 101 pts [Pagat: "Each unplayed joker left in a player's hand counts 101"]
    DISCARD_OKEY_PENALTY: 101,        // Immediate penalty for discarding an Okey without going out [Pagat: "A player who discards a joker is penalised 101 points"]

    // Scenario A: Winner opened with sets/runs & discarded a normal tile [Pagat Scoring Table]
    SCENARIO_A: Object.freeze({
      winnerBonus: -101,
      unopenedPenalty: 202,
      openedSetsMultiplier: 1,
      openedPairsMultiplier: 2
    }),

    // Scenario B: Winner opened with sets/runs & discarded an Okey (Joker) [Pagat Scoring Table]
    SCENARIO_B: Object.freeze({
      winnerBonus: -202,
      unopenedPenalty: 404,
      openedSetsMultiplier: 2,
      openedPairsMultiplier: 4
    }),

    // Scenario C: Winner opened with pairs & discarded a normal tile [Pagat Scoring Table]
    SCENARIO_C: Object.freeze({
      winnerBonus: -202,
      unopenedPenalty: 404,
      openedSetsMultiplier: 2,
      openedPairsMultiplier: 4
    }),

    // Scenario D: Winner opened with pairs & discarded an Okey (Joker) [Pagat Scoring Table]
    SCENARIO_D: Object.freeze({
      winnerBonus: -404,
      unopenedPenalty: 404, // Pagat: unopened players still score 404
      openedSetsMultiplier: 4,
      openedPairsMultiplier: 8
    }),

    // Draw pile runs out before anyone goes out [Pagat: "no one gets points for winning"]
    STOCK_EXHAUSTED: Object.freeze({
      winnerBonus: 0,
      unopenedPenalty: 202,
      openedSetsMultiplier: 1,
      openedPairsMultiplier: 2
    })
  });

  // ---------------------------------------------------------------------------
  // Deterministic Seeded PRNG (xmur3 + mulberry32)
  // ---------------------------------------------------------------------------
  function hashSeed(seedStr) {
    const str = String(seedStr == null ? 'okey101-default-seed' : seedStr);
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }

  function createRng(seed) {
    let a = typeof seed === 'number' ? (seed >>> 0) : hashSeed(seed);
    if (a === 0) a = 0x6d2b79f5;
    return function nextFloat() {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // Tile & Okey / Fake Joker Helpers
  // ---------------------------------------------------------------------------
  function createDeck() {
    const deck = [];
    let id = 1;
    for (let copy = 1; copy <= 2; copy++) {
      for (const color of COLORS) {
        for (let number = 1; number <= 13; number++) {
          deck.push({ id: id++, color, number, isFakeJoker: false });
        }
      }
    }
    // 2 Fake Jokers (Sahte Okey)
    deck.push({ id: id++, color: null, number: null, isFakeJoker: true });
    deck.push({ id: id++, color: null, number: null, isFakeJoker: true });
    return deck;
  }

  function shuffleDeck(deck, seed) {
    const rng = typeof seed === 'function' ? seed : createRng(seed);
    const out = deck.map((t) => Object.assign({}, t));
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function getOkeySpec(indicator) {
    if (!indicator || indicator.isFakeJoker) {
      throw new Error('Indicator tile cannot be a Fake Joker');
    }
    return {
      color: indicator.color,
      number: indicator.number === 13 ? 1 : indicator.number + 1
    };
  }

  function isOkeyTile(tile, indicator) {
    if (!tile || tile.isFakeJoker) return false;
    const okey = getOkeySpec(indicator);
    return tile.color === okey.color && tile.number === okey.number;
  }

  /**
   * Returns the effective playing identity of a tile given the indicator:
   * - Real Okey tile -> { isWild: true, color, number }
   * - Fake Joker -> { isWild: false, color: okey.color, number: okey.number }
   * - Normal tile -> { isWild: false, color: tile.color, number: tile.number }
   */
  function getEffectiveTile(tile, indicator) {
    const okey = getOkeySpec(indicator);
    if (tile.isFakeJoker) {
      return { id: tile.id, isWild: false, isFakeJoker: true, color: okey.color, number: okey.number };
    }
    if (tile.color === okey.color && tile.number === okey.number) {
      return { id: tile.id, isWild: true, isFakeJoker: false, color: tile.color, number: tile.number };
    }
    return { id: tile.id, isWild: false, isFakeJoker: false, color: tile.color, number: tile.number };
  }

  // ---------------------------------------------------------------------------
  // Meld Validation (Pairs, Sets, Runs)
  // ---------------------------------------------------------------------------
  function validatePair(tiles, indicator) {
    if (!Array.isArray(tiles) || tiles.length !== 2) {
      return { valid: false, reason: 'A pair must contain exactly 2 tiles.' };
    }
    const eff = tiles.map((t) => getEffectiveTile(t, indicator));
    const nonWilds = eff.filter((e) => !e.isWild);

    if (nonWilds.length === 0) {
      // Two Okeys paired together: each counts as 13 (or face okey value), valid pair
      const okey = getOkeySpec(indicator);
      return {
        valid: true,
        kind: 'pair',
        points: okey.number * 2,
        pairColor: okey.color,
        pairNumber: okey.number,
        orderedTiles: tiles.slice(),
        resolvedNumbers: [okey.number, okey.number]
      };
    }

    if (nonWilds.length === 1) {
      // 1 normal/fake-joker + 1 wild Okey
      const nw = nonWilds[0];
      return {
        valid: true,
        kind: 'pair',
        points: nw.number * 2,
        pairColor: nw.color,
        pairNumber: nw.number,
        orderedTiles: tiles.slice(),
        resolvedNumbers: [nw.number, nw.number]
      };
    }

    // 2 non-wild tiles: must have identical effective color AND number
    if (nonWilds[0].color === nonWilds[1].color && nonWilds[0].number === nonWilds[1].number) {
      return {
        valid: true,
        kind: 'pair',
        points: nonWilds[0].number * 2,
        pairColor: nonWilds[0].color,
        pairNumber: nonWilds[0].number,
        orderedTiles: tiles.slice(),
        resolvedNumbers: [nonWilds[0].number, nonWilds[0].number]
      };
    }

    return { valid: false, reason: 'Pair tiles must match in both color and number.' };
  }

  function validateSet(tiles, indicator) {
    if (!Array.isArray(tiles) || (tiles.length !== 3 && tiles.length !== 4)) {
      return { valid: false, reason: 'A set must have 3 or 4 tiles.' };
    }
    const eff = tiles.map((t) => getEffectiveTile(t, indicator));
    const nonWilds = eff.filter((e) => !e.isWild);

    if (nonWilds.length === 0) {
      return { valid: false, reason: 'A set cannot consist solely of wild tiles.' };
    }

    const targetNumber = nonWilds[0].number;
    const seenColors = new Set();
    for (const nw of nonWilds) {
      if (nw.number !== targetNumber) {
        return { valid: false, reason: 'All tiles in a set must have the same number.' };
      }
      if (seenColors.has(nw.color)) {
        return { valid: false, reason: 'All tiles in a set must have different colors.' };
      }
      seenColors.add(nw.color);
    }

    return {
      valid: true,
      kind: 'set',
      setNumber: targetNumber,
      usedColors: Array.from(seenColors),
      points: targetNumber * tiles.length,
      orderedTiles: tiles.slice(),
      resolvedNumbers: tiles.map(() => targetNumber)
    };
  }

  function validateRun(tiles, indicator, config) {
    const cfg = config || SCORING_CONFIG;
    if (!Array.isArray(tiles) || tiles.length < 3 || tiles.length > 13) {
      return { valid: false, reason: 'A run must contain between 3 and 13 tiles.' };
    }
    const L = tiles.length;
    const eff = tiles.map((t) => getEffectiveTile(t, indicator));
    const nonWilds = eff.filter((e) => !e.isWild);

    if (nonWilds.length === 0) {
      return { valid: false, reason: 'A run must contain at least one non-wild tile.' };
    }

    const runColor = nonWilds[0].color;
    for (const nw of nonWilds) {
      if (nw.color !== runColor) {
        return { valid: false, reason: 'All tiles in a run must be the same color.' };
      }
    }

    // 1. Check if the exact order supplied by the player already forms a valid consecutive sequence
    let impliedStart = null;
    let exactOrderMatches = true;
    for (let i = 0; i < L; i++) {
      if (!eff[i].isWild) {
        const candidateStart = eff[i].number - i;
        if (impliedStart === null) {
          impliedStart = candidateStart;
        } else if (impliedStart !== candidateStart) {
          exactOrderMatches = false;
          break;
        }
      }
    }

    const maxAllowedNum = cfg.ALLOW_HIGH_ACE ? 14 : 13;
    if (exactOrderMatches && impliedStart !== null && impliedStart >= 1 && (impliedStart + L - 1) <= 13) {
      const resolvedNumbers = [];
      let points = 0;
      for (let i = 0; i < L; i++) {
        const num = impliedStart + i;
        resolvedNumbers.push(num);
        points += num;
      }
      return {
        valid: true,
        kind: 'run',
        runColor,
        startNumber: impliedStart,
        endNumber: impliedStart + L - 1,
        points,
        orderedTiles: tiles.slice(),
        resolvedNumbers
      };
    }

    // 2. Otherwise, check if the tiles can be arranged into a valid run (filling internal gaps with wilds,
    //    then extending upward up to 13 first to maximize points, then downward to 1).
    const sortedNonWilds = nonWilds.slice().sort((a, b) => a.number - b.number);
    for (let i = 1; i < sortedNonWilds.length; i++) {
      if (sortedNonWilds[i].number === sortedNonWilds[i - 1].number) {
        return { valid: false, reason: 'A run cannot contain duplicate numbers.' };
      }
    }

    const minNum = sortedNonWilds[0].number;
    const maxNum = sortedNonWilds[sortedNonWilds.length - 1].number;
    const span = maxNum - minNum + 1;
    if (span > L || maxNum > maxAllowedNum) {
      return { valid: false, reason: 'Tiles do not form a consecutive run (12-13-1 wrap is not allowed).' };
    }

    // Place extra wilds at the high end up to 13 first (maximizes opening points), remainder at the low end
    const extraWilds = L - span;
    const canAddHigh = Math.min(extraWilds, 13 - maxNum);
    const endNumber = maxNum + canAddHigh;
    const startNumber = endNumber - L + 1;
    if (startNumber < 1 || endNumber > 13) {
      return { valid: false, reason: 'Run exceeds valid number bounds (1..13).' };
    }

    const byNumber = new Map();
    for (let i = 0; i < L; i++) {
      if (!eff[i].isWild) {
        byNumber.set(eff[i].number, tiles[i]);
      }
    }
    const wildTiles = [];
    for (let i = 0; i < L; i++) {
      if (eff[i].isWild) wildTiles.push(tiles[i]);
    }

    const orderedTiles = [];
    const resolvedNumbers = [];
    let points = 0;
    for (let num = startNumber; num <= endNumber; num++) {
      resolvedNumbers.push(num);
      points += num;
      if (byNumber.has(num)) {
        orderedTiles.push(byNumber.get(num));
      } else {
        orderedTiles.push(wildTiles.shift());
      }
    }

    return {
      valid: true,
      kind: 'run',
      runColor,
      startNumber,
      endNumber,
      points,
      orderedTiles,
      resolvedNumbers
    };
  }

  /**
   * Auto-detect and validate a meld (pair, set, or run).
   */
  function validateMeld(tiles, indicator, config) {
    if (!Array.isArray(tiles) || tiles.length < 2) {
      return { valid: false, reason: 'A meld requires at least 2 tiles.' };
    }
    if (tiles.length === 2) {
      return validatePair(tiles, indicator);
    }
    const runRes = validateRun(tiles, indicator, config);
    if (runRes.valid) return runRes;

    const setRes = validateSet(tiles, indicator);
    if (setRes.valid) return setRes;

    return { valid: false, reason: runRes.reason || setRes.reason || 'Invalid meld.' };
  }

  /**
   * Validate an opening submission (list of tile arrays).
   * Rejects mixing pairs and runs/sets, checks >= 101 points for sets/runs or >= 5 pairs.
   */
  function validateOpening(meldGroups, indicator, config) {
    const cfg = config || SCORING_CONFIG;
    if (!Array.isArray(meldGroups) || meldGroups.length === 0) {
      return { valid: false, reason: 'No melds provided for opening.' };
    }

    const seenTileIds = new Set();
    const validatedMelds = [];
    let hasPairs = false;
    let hasSetsOrRuns = false;
    let totalPoints = 0;

    for (const group of meldGroups) {
      if (!Array.isArray(group) || group.length < 2) {
        return { valid: false, reason: 'Each meld must have at least 2 tiles.' };
      }
      for (const t of group) {
        if (!t || seenTileIds.has(t.id)) {
          return { valid: false, reason: 'Duplicate tile used across multiple melds.' };
        }
        seenTileIds.add(t.id);
      }

      const res = validateMeld(group, indicator, cfg);
      if (!res.valid) {
        return { valid: false, reason: res.reason };
      }
      if (res.kind === 'pair') {
        hasPairs = true;
      } else {
        hasSetsOrRuns = true;
      }
      totalPoints += res.points;
      validatedMelds.push(res);
    }

    if (hasPairs && hasSetsOrRuns) {
      return { valid: false, reason: 'Cannot mix pairs and sets/runs when opening.' };
    }

    if (hasPairs) {
      if (validatedMelds.length < cfg.MIN_OPEN_PAIRS) {
        return {
          valid: false,
          mode: 'pairs',
          pairCount: validatedMelds.length,
          totalPoints,
          reason: `Need at least ${cfg.MIN_OPEN_PAIRS} pairs to open (currently ${validatedMelds.length}).`
        };
      }
      return {
        valid: true,
        mode: 'pairs',
        pairCount: validatedMelds.length,
        totalPoints,
        melds: validatedMelds
      };
    }

    if (totalPoints < cfg.MIN_OPEN_POINTS) {
      return {
        valid: false,
        mode: 'sets',
        totalPoints,
        reason: `Need at least ${cfg.MIN_OPEN_POINTS} points to open (currently ${totalPoints}).`
      };
    }

    return {
      valid: true,
      mode: 'sets',
      totalPoints,
      melds: validatedMelds
    };
  }

  /**
   * Validate laying off 1 or more tiles onto an existing table meld.
   * Also supports Okey (Joker) retrieval: if a run/set on the table contains a wild Okey
   * (e.g. "8, 9, Joker, 11") and the player lays off the exact tile the Joker represents ("10"),
   * the tile replaces the Joker in the meld and `retrievedOkey` is returned to the player's hand.
   */
  function validateLayOff(tableMeld, newTiles, indicator, config) {
    const cfg = config || SCORING_CONFIG;
    if (!tableMeld || !Array.isArray(newTiles) || newTiles.length === 0) {
      return { valid: false, reason: 'Select at least one tile to lay off.' };
    }
    if (tableMeld.kind === 'pair') {
      return { valid: false, reason: 'Cannot lay off tiles onto a pair.' };
    }

    // Check for Okey (Joker) retrieval when laying off a single non-wild tile
    if (cfg.ALLOW_OKEY_RETRIEVAL !== false && newTiles.length === 1) {
      const candidateTile = newTiles[0];
      const effCand = getEffectiveTile(candidateTile, indicator);
      if (!effCand.isWild) {
        if (tableMeld.kind === 'run') {
          const curRun = validateRun(tableMeld.tiles, indicator, cfg);
          if (curRun.valid && effCand.color === curRun.runColor) {
            for (let i = 0; i < curRun.orderedTiles.length; i++) {
              const t = curRun.orderedTiles[i];
              if (isOkeyTile(t, indicator) && curRun.resolvedNumbers[i] === effCand.number) {
                const replacedTiles = curRun.orderedTiles.slice();
                replacedTiles[i] = candidateTile;
                return {
                  valid: true,
                  kind: 'run',
                  runColor: curRun.runColor,
                  startNumber: curRun.startNumber,
                  endNumber: curRun.endNumber,
                  points: curRun.points,
                  orderedTiles: replacedTiles,
                  resolvedNumbers: curRun.resolvedNumbers.slice(),
                  retrievedOkey: t
                };
              }
            }
          }
        } else if (tableMeld.kind === 'set') {
          // In a set, the Joker can ONLY be retrieved when there are already 3 real tiles + 1 Joker (4 tiles total)
          // and the player lays the 4th missing color. (If there are only 2 real tiles + 1 Joker, laying a 3rd color
          // simply extends the 3-tile set to a 4-tile set without retrieving the Joker.)
          const curSet = validateSet(tableMeld.tiles, indicator);
          if (
            curSet.valid &&
            tableMeld.tiles.length === 4 &&
            curSet.usedColors.length === 3 &&
            effCand.number === curSet.setNumber &&
            !curSet.usedColors.includes(effCand.color)
          ) {
            const wildIdx = curSet.orderedTiles.findIndex((t) => isOkeyTile(t, indicator));
            if (wildIdx !== -1) {
              const retrieved = curSet.orderedTiles[wildIdx];
              const replacedTiles = curSet.orderedTiles.slice();
              replacedTiles[wildIdx] = candidateTile;
              return {
                valid: true,
                kind: 'set',
                setNumber: curSet.setNumber,
                usedColors: curSet.usedColors.concat([effCand.color]),
                points: curSet.points,
                orderedTiles: replacedTiles,
                resolvedNumbers: curSet.resolvedNumbers.slice(),
                retrievedOkey: retrieved
              };
            }
          }
        }
      }
    }

    const combined = tableMeld.tiles.concat(newTiles);
    if (tableMeld.kind === 'set') {
      const res = validateSet(combined, indicator);
      if (!res.valid) return res;
      return res;
    }
    if (tableMeld.kind === 'run') {
      // Try appending at the end, prepending at the start, or general run validation
      const prepend = validateRun(newTiles.concat(tableMeld.tiles), indicator, cfg);
      if (prepend.valid) return prepend;
      const append = validateRun(tableMeld.tiles.concat(newTiles), indicator, cfg);
      if (append.valid) return append;
      return validateRun(combined, indicator, cfg);
    }
    return { valid: false, reason: 'Unsupported table meld type.' };
  }

  // ---------------------------------------------------------------------------
  // Rack Sorting Helpers (Sort by Runs / Sort by Sets) + Auto-Staged Melds Finder
  // ---------------------------------------------------------------------------
  function sortRackByRuns(rack, indicator) {
    const colorOrder = { red: 0, yellow: 1, blue: 2, black: 3 };
    return rack.slice().sort((a, b) => {
      const ea = getEffectiveTile(a, indicator);
      const eb = getEffectiveTile(b, indicator);
      if (ea.isWild !== eb.isWild) return ea.isWild ? 1 : -1;
      if (ea.color !== eb.color) return (colorOrder[ea.color] || 0) - (colorOrder[eb.color] || 0);
      if (ea.number !== eb.number) return ea.number - eb.number;
      return a.id - b.id;
    });
  }

  function sortRackBySets(rack, indicator) {
    const colorOrder = { red: 0, yellow: 1, blue: 2, black: 3 };
    return rack.slice().sort((a, b) => {
      const ea = getEffectiveTile(a, indicator);
      const eb = getEffectiveTile(b, indicator);
      if (ea.isWild !== eb.isWild) return ea.isWild ? 1 : -1;
      if (ea.number !== eb.number) return ea.number - eb.number;
      if (ea.color !== eb.color) return (colorOrder[ea.color] || 0) - (colorOrder[eb.color] || 0);
      return a.id - b.id;
    });
  }

  /**
   * Finds all tiles in `rack` that can be laid off onto `tableMelds` (including chained lay-offs,
   * e.g. laying off 5 onto 2-3-4 and then 6 onto 2-3-4-5), while keeping at least 1 tile in rack for discard.
   * Returns:
   *   - steps: Array of { tileId, meldId, tile } in execution order
   *   - isleTileIds: Set of all tile IDs in rack that can be laid off (for the red-dot indicator)
   */
  function findIslePlan(rack, tableMelds, indicator, config) {
    const cfg = config || SCORING_CONFIG;
    const isleTileIds = new Set();
    const steps = [];
    if (!Array.isArray(rack) || !Array.isArray(tableMelds) || tableMelds.length === 0 || !indicator) {
      return { steps, isleTileIds };
    }

    // 1. Any non-wild tile that directly fits (or swaps for a Joker in) any current table meld gets the red dot
    for (const t of rack) {
      if (isOkeyTile(t, indicator)) continue; // Do not auto-dump the player's wild Okey on İŞLE
      for (const tm of tableMelds) {
        if (validateLayOff(tm, [t], indicator, cfg).valid) {
          isleTileIds.add(t.id);
          break;
        }
      }
    }

    // 2. Compute the full chained lay-off sequence (keeping at least 1 tile in rack to discard)
    const workingMelds = tableMelds.map((m) => ({
      id: m.id,
      ownerSeat: m.ownerSeat,
      kind: m.kind,
      points: m.points,
      tiles: m.tiles.slice()
    }));
    const remainingRack = rack.slice();

    let progress = true;
    while (progress && remainingRack.length >= 1) {
      progress = false;
      for (let i = 0; i < remainingRack.length; i++) {
        const tile = remainingRack[i];
        if (isOkeyTile(tile, indicator)) continue; // Keep retrieved or held wild Okeys in the player's hand
        let matchedMeld = null;
        let matchedRes = null;
        for (const wm of workingMelds) {
          const res = validateLayOff(wm, [tile], indicator, cfg);
          if (res.valid) {
            // If this lay-off does NOT retrieve an Okey, we must keep at least 1 tile left in rack for discard
            if (!res.retrievedOkey && remainingRack.length <= 1) {
              continue;
            }
            matchedMeld = wm;
            matchedRes = res;
            break;
          }
        }
        if (matchedMeld && matchedRes) {
          matchedMeld.tiles = matchedRes.orderedTiles;
          matchedMeld.points = matchedRes.points;
          remainingRack.splice(i, 1);
          if (matchedRes.retrievedOkey) {
            remainingRack.push(matchedRes.retrievedOkey);
          }
          isleTileIds.add(tile.id);
          steps.push({
            tileId: tile.id,
            meldId: matchedMeld.id,
            tile,
            retrievedOkey: matchedRes.retrievedOkey || null
          });
          progress = true;
          break;
        }
      }
    }

    return { steps, isleTileIds };
  }

  /**
   * Finds an optimal valid partition of a rack into disjoint melds (runs/sets or pairs),
   * always leaving at least 1 tile in the rack for discard.
   * Uses candidate generation + branch-and-bound search so overlapping runs and sets
   * are resolved to maximize total opening points (and lay out every possible meld cleanly).
   */
  function findBestMeldsInRack(rack, indicator, requiredTileId, config) {
    const cfg = config || SCORING_CONFIG;
    const wilds = [];
    const normals = [];
    for (const t of rack) {
      const eff = getEffectiveTile(t, indicator);
      if (eff.isWild) wilds.push(t);
      else normals.push({ tile: t, color: eff.color, number: eff.number });
    }

    // -------------------------------------------------------------------------
    // 1. Pairs Candidate (for ÇİFT DİZ / ÇİFT AÇ)
    // -------------------------------------------------------------------------
    const pairGroups = [];
    const usedIdsForPairs = new Set();
    const byKey = new Map();
    for (const n of normals) {
      const key = `${n.color}:${n.number}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(n.tile);
    }
    const sortedPairKeys = Array.from(byKey.keys()).sort((a, b) => {
      const na = Number(a.split(':')[1]);
      const nb = Number(b.split(':')[1]);
      return nb - na;
    });
    for (const key of sortedPairKeys) {
      const list = byKey.get(key);
      if (list.length >= 2) {
        pairGroups.push([list[0], list[1]]);
        usedIdsForPairs.add(list[0].id);
        usedIdsForPairs.add(list[1].id);
      }
    }
    const leftoverNormalsForPairs = normals
      .filter((n) => !usedIdsForPairs.has(n.tile.id))
      .sort((a, b) => {
        if (requiredTileId && (a.tile.id === requiredTileId || b.tile.id === requiredTileId)) {
          return a.tile.id === requiredTileId ? -1 : 1;
        }
        return b.number - a.number;
      });
    const availWildsForPairs = wilds.slice();
    while (availWildsForPairs.length > 0 && leftoverNormalsForPairs.length > 0) {
      const w = availWildsForPairs.shift();
      const n = leftoverNormalsForPairs.shift();
      pairGroups.push([n.tile, w]);
      usedIdsForPairs.add(w.id);
      usedIdsForPairs.add(n.tile.id);
    }
    while (pairGroups.length * 2 >= rack.length && pairGroups.length > 0) {
      pairGroups.pop();
    }
    const pairsIncludeReq = !requiredTileId || pairGroups.some((m) => m.some((t) => t.id === requiredTileId));

    // -------------------------------------------------------------------------
    // 2. Generate All Candidate Pure Runs & Sets (Lengths 3..13)
    // -------------------------------------------------------------------------
    const candidates = [];

    // 2a. Candidate Sets (3 or 4 tiles of the same number and distinct colors)
    const byNumber = new Map();
    for (const n of normals) {
      if (!byNumber.has(n.number)) byNumber.set(n.number, new Map());
      const cm = byNumber.get(n.number);
      if (!cm.has(n.color)) cm.set(n.color, []);
      cm.get(n.color).push(n.tile);
    }

    for (const [num, cm] of byNumber.entries()) {
      const colorsPresent = Array.from(cm.keys());
      if (colorsPresent.length >= 3) {
        // Primary copy of each color
        const tilesAll = colorsPresent.map((c) => cm.get(c)[0]);
        if (tilesAll.length === 4) {
          candidates.push({
            kind: 'set',
            tiles: tilesAll,
            ids: tilesAll.map((t) => t.id),
            points: num * 4
          });
          // Also add the four 3-tile subsets in case one tile is needed for a long run
          for (let skip = 0; skip < 4; skip++) {
            const sub = tilesAll.filter((_, idx) => idx !== skip);
            candidates.push({
              kind: 'set',
              tiles: sub,
              ids: sub.map((t) => t.id),
              points: num * 3
            });
          }
        } else {
          candidates.push({
            kind: 'set',
            tiles: tilesAll,
            ids: tilesAll.map((t) => t.id),
            points: num * 3
          });
        }
        // If any color has a second copy, add a candidate set using the second copy
        const hasSecondCopy = colorsPresent.some((c) => cm.get(c).length > 1);
        if (hasSecondCopy) {
          const altTiles = colorsPresent.map((c) => {
            const list = cm.get(c);
            return list.length > 1 ? list[1] : list[0];
          }).slice(0, 4);
          if (altTiles.length >= 3) {
            candidates.push({
              kind: 'set',
              tiles: altTiles,
              ids: altTiles.map((t) => t.id),
              points: num * altTiles.length
            });
          }
        }
      }
    }

    // 2b. Candidate Runs (3+ consecutive numbers in the same color, up to 2 copies per color/number)
    for (const color of COLORS) {
      const byNumList = new Map();
      for (const n of normals) {
        if (n.color !== color) continue;
        if (!byNumList.has(n.number)) byNumList.set(n.number, []);
        byNumList.get(n.number).push(n.tile);
      }
      for (let copyLayer = 0; copyLayer < 2; copyLayer++) {
        for (let start = 1; start <= 11; start++) {
          const seq = [];
          for (let num = start; num <= 13; num++) {
            const list = byNumList.get(num);
            if (!list || list.length === 0) break;
            const tile = list.length > copyLayer ? list[copyLayer] : (copyLayer === 0 ? list[0] : null);
            if (!tile) break;
            seq.push(tile);
            if (seq.length >= 3) {
              const pts = ((start + num) * seq.length) / 2;
              candidates.push({
                kind: 'run',
                tiles: seq.slice(),
                ids: seq.map((t) => t.id),
                points: pts
              });
            }
          }
        }
      }
    }

    // Sort candidates by points descending, then length descending
    candidates.sort((a, b) => (b.points - a.points) || (b.tiles.length - a.tiles.length));

    // Branch-and-bound search for best disjoint set of pure candidates
    const maxTilesAllowed = Math.max(0, rack.length - 1);
    let bestScore = -1;
    let bestCombo = [];
    const usedIdSet = new Set();
    const currentCombo = [];

    // Precompute suffix upper bound on points
    const suffixMaxPts = new Array(candidates.length + 1).fill(0);
    for (let i = candidates.length - 1; i >= 0; i--) {
      suffixMaxPts[i] = suffixMaxPts[i + 1] + candidates[i].points;
    }

    let nodesVisited = 0;
    const MAX_NODES = 2500;

    function search(idx, curPoints, curTileCount) {
      if (nodesVisited++ > MAX_NODES) return;
      const includesReq = !requiredTileId || currentCombo.some((c) => c.ids.includes(requiredTileId));
      const effectiveScore = curPoints + (includesReq ? 10000 : 0) + currentCombo.length * 0.1;
      if (effectiveScore > bestScore) {
        bestScore = effectiveScore;
        bestCombo = currentCombo.slice();
      }
      if (idx >= candidates.length) return;
      if (curPoints + suffixMaxPts[idx] + 10005 < bestScore) return;

      for (let i = idx; i < candidates.length; i++) {
        const cand = candidates[i];
        if (curTileCount + cand.tiles.length > maxTilesAllowed) continue;
        let overlaps = false;
        for (let k = 0; k < cand.ids.length; k++) {
          if (usedIdSet.has(cand.ids[k])) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;

        for (let k = 0; k < cand.ids.length; k++) usedIdSet.add(cand.ids[k]);
        currentCombo.push(cand);
        search(i + 1, curPoints + cand.points, curTileCount + cand.tiles.length);
        currentCombo.pop();
        for (let k = 0; k < cand.ids.length; k++) usedIdSet.delete(cand.ids[k]);
      }
    }

    search(0, 0, 0);

    // Collect chosen melds and remaining unused tiles
    const finalMelds = bestCombo.map((c) => c.tiles.slice());
    const usedIds = new Set(finalMelds.flatMap((m) => m.map((t) => t.id)));
    const availWilds = wilds.slice();

    // -------------------------------------------------------------------------
    // 3. Use any Wild Okey tiles to complete high-value 2-tile near-melds or extend runs/sets
    // -------------------------------------------------------------------------
    while (availWilds.length > 0 && (usedIds.size + 1) < rack.length) {
      const remainingNormals = normals.filter((n) => !usedIds.has(n.tile.id));
      const wildCandidates = [];

      // 3a. 2-tile same-number distinct-color pairs -> 3-tile Set with 1 wild
      const remByNum = new Map();
      for (const n of remainingNormals) {
        if (!remByNum.has(n.number)) remByNum.set(n.number, new Map());
        const cm = remByNum.get(n.number);
        if (!cm.has(n.color)) cm.set(n.color, n.tile);
      }
      for (const [num, cm] of remByNum.entries()) {
        const list = Array.from(cm.values());
        if (list.length === 2 && (usedIds.size + 3) <= maxTilesAllowed) {
          wildCandidates.push({ points: num * 3, tiles: list });
        }
      }

      // 3b. 2-tile same-color consecutive or gap-1 pairs -> 3-tile Run with 1 wild
      for (const color of COLORS) {
        const list = remainingNormals
          .filter((n) => n.color === color)
          .sort((a, b) => b.number - a.number);
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const hi = list[i];
            const lo = list[j];
            const diff = hi.number - lo.number;
            if ((diff === 1 || diff === 2) && (usedIds.size + 3) <= maxTilesAllowed) {
              const w = availWilds[0];
              const v = validateRun([lo.tile, hi.tile, w], indicator, cfg);
              if (v.valid) {
                wildCandidates.push({ points: v.points, tiles: [lo.tile, hi.tile] });
              }
            }
          }
        }
      }

      wildCandidates.sort((a, b) => b.points - a.points);
      let attached = false;
      for (const wc of wildCandidates) {
        if (wc.tiles.some((t) => usedIds.has(t.id))) continue;
        const w = availWilds.shift();
        const group = wc.tiles.concat([w]);
        const v = validateMeld(group, indicator, cfg);
        if (v.valid) {
          finalMelds.push(v.orderedTiles);
          group.forEach((t) => usedIds.add(t.id));
          attached = true;
          break;
        } else {
          availWilds.unshift(w);
        }
      }

      // 3c. If no 2-tile near-meld exists, try extending an existing meld with the wild
      if (!attached && availWilds.length > 0 && finalMelds.length > 0 && (usedIds.size + 1) <= maxTilesAllowed) {
        const w = availWilds[0];
        let bestExtIdx = -1;
        let bestExtGain = -1;
        let bestExtOrdered = null;
        for (let mIdx = 0; mIdx < finalMelds.length; mIdx++) {
          const prevV = validateMeld(finalMelds[mIdx], indicator, cfg);
          const extV = validateMeld(finalMelds[mIdx].concat([w]), indicator, cfg);
          if (prevV.valid && extV.valid) {
            const gain = extV.points - prevV.points;
            if (gain > bestExtGain) {
              bestExtGain = gain;
              bestExtIdx = mIdx;
              bestExtOrdered = extV.orderedTiles;
            }
          }
        }
        if (bestExtIdx !== -1) {
          availWilds.shift();
          finalMelds[bestExtIdx] = bestExtOrdered;
          usedIds.add(w.id);
          attached = true;
        }
      }

      if (!attached) break;
    }

    // Order melds cleanly by point value descending (just like the second reference photo)
    const validatedSetsAndRuns = [];
    let totalSetsPoints = 0;
    for (const m of finalMelds) {
      const v = validateMeld(m, indicator, cfg);
      if (v.valid && v.kind !== 'pair') {
        validatedSetsAndRuns.push({ orderedTiles: v.orderedTiles, points: v.points });
        totalSetsPoints += v.points;
      }
    }
    validatedSetsAndRuns.sort((a, b) => b.points - a.points);
    const orderedMelds = validatedSetsAndRuns.map((x) => x.orderedTiles);
    const includesReq = !requiredTileId || orderedMelds.some((m) => m.some((t) => t.id === requiredTileId));

    return {
      setsCandidate: { melds: orderedMelds, points: totalSetsPoints, includesReq },
      pairsCandidate: { melds: pairGroups, count: pairGroups.length, includesReq: pairsIncludeReq }
    };
  }

  // ---------------------------------------------------------------------------
  // Game State Creation & Lifecycle
  // ---------------------------------------------------------------------------
  function createGameState(options) {
    const opts = options || {};
    const config = Object.assign({}, SCORING_CONFIG, opts.config || {});
    const roomCode = String(opts.roomCode || 'LOCAL1').toUpperCase();
    const seed = opts.seed != null ? String(opts.seed) : `${roomCode}-${Date.now()}`;
    const totalRounds = opts.totalRounds || config.DEFAULT_ROUNDS;

    const seats = [];
    for (let i = 0; i < 4; i++) {
      const seatOpt = (opts.seats && opts.seats[i]) || {};
      seats.push({
        seat: i,
        name: seatOpt.name || (i === 0 ? 'Host (P1)' : `Player ${i + 1}`),
        isBot: Boolean(seatOpt.isBot),
        connected: seatOpt.connected !== undefined ? Boolean(seatOpt.connected) : (i === 0 || Boolean(seatOpt.isBot)),
        seatToken: seatOpt.seatToken || `token-seat-${i}-${hashSeed(seed + ':' + i).toString(16)}`,
        rack: [],
        openedMode: null, // null | 'sets' | 'pairs'
        discardPile: [],
        roundScore: 0,
        totalScore: 0,
        penaltyAdjust: 0,
        mustOpenWithTileId: null,
        takenDiscardTileId: null,
        readyNext: null
      });
    }

    const state = {
      version: 1,
      seq: 1,
      roomCode,
      seed,
      config,
      phase: 'lobby', // 'lobby' | 'playing' | 'roundEnd' | 'matchEnd'
      roundIndex: 0,
      totalRounds,
      starterSeat: 0,
      currentTurn: 0,
      turnPhase: 'act', // 'draw' | 'act'
      turnDeadlineMs: null,
      indicator: null,
      okeySpec: null,
      drawPile: [],
      tableMelds: [],
      nextMeldId: 1,
      seats,
      lastAction: null,
      winnerSeat: null,
      matchWinnerSeat: null,
      roundHistory: []
    };

    if (opts.autoStart) {
      startRound(state, 0);
    }
    return state;
  }

  function startRound(state, roundIndex) {
    const rIdx = roundIndex != null ? roundIndex : state.roundIndex;
    state.roundIndex = rIdx;
    state.phase = 'playing';
    state.starterSeat = rIdx % 4;
    state.currentTurn = state.starterSeat;
    // Starter begins with 22 tiles and skips the first draw ('act' phase)
    state.turnPhase = 'act';
    state.tableMelds = [];
    state.nextMeldId = 1;
    state.winnerSeat = null;

    const roundSeed = `${state.seed}:round:${rIdx}`;
    const rng = createRng(roundSeed);
    const deck = shuffleDeck(createDeck(), rng);

    // Pick face-up indicator tile (if Fake Joker, redraw until a numbered tile is chosen)
    let indicatorIdx = deck.findIndex((t) => !t.isFakeJoker);
    const [indicator] = deck.splice(indicatorIdx, 1);
    state.indicator = indicator;
    state.okeySpec = getOkeySpec(indicator);

    // Deal 22 tiles to starterSeat, 21 tiles to the other 3 seats (total 85 tiles dealt, 1 indicator, 20 in drawPile)
    for (let s = 0; s < 4; s++) {
      const count = s === state.starterSeat ? 22 : 21;
      const seatObj = state.seats[s];
      seatObj.rack = sortRackByRuns(deck.splice(0, count), indicator);
      seatObj.openedMode = null;
      seatObj.discardPile = [];
      seatObj.roundScore = 0;
      seatObj.penaltyAdjust = 0;
      seatObj.mustOpenWithTileId = null;
      seatObj.takenDiscardTileId = null;
      seatObj.readyNext = seatObj.isBot ? 'accepted' : null;
    }

    state.drawPile = deck; // Remaining 20 tiles
    state.seq++;
    state.lastAction = {
      type: 'ROUND_START',
      roundIndex: rIdx,
      starterSeat: state.starterSeat
    };
    return state;
  }

  // ---------------------------------------------------------------------------
  // Intent Validation & Execution (Host-Authoritative Engine)
  // ---------------------------------------------------------------------------
  function previousSeat(seat) {
    return (seat + 3) % 4;
  }

  function nextSeat(seat) {
    return (seat + 1) % 4;
  }

  function advanceToNextRoundOrRematch(state, forceReplaceWaiting) {
    // Convert any seat that declined or disconnected (or didn't accept when host explicitly force-starts) into a Bot
    const botNames = ['Alper (Bot)', 'Gamze (Bot)', 'Zeynep (Bot)', 'Mert (Bot)'];
    for (let s = 1; s < 4; s++) {
      const seatObj = state.seats[s];
      const shouldBecomeBot = !seatObj.isBot && (
        seatObj.readyNext === 'declined' ||
        !seatObj.connected ||
        (forceReplaceWaiting && seatObj.readyNext !== 'accepted')
      );
      if (shouldBecomeBot) {
        seatObj.isBot = true;
        seatObj.connected = true;
        seatObj.name = botNames[s] || `Bot ${s + 1}`;
        seatObj.seatToken = `bot-replaced-${s}-${Date.now()}`;
        seatObj.readyNext = 'accepted';
      }
    }

    if (state.phase === 'matchEnd' || state.roundIndex + 1 >= state.totalRounds) {
      // Rematch in the same lobby: reset match scores and start from Round 0
      state.roundHistory = [];
      state.matchWinnerSeat = null;
      for (let s = 0; s < 4; s++) {
        state.seats[s].totalScore = 0;
      }
      startRound(state, 0);
      return { ok: true, state, event: 'REMATCH_START' };
    }

    startRound(state, state.roundIndex + 1);
    return { ok: true, state, event: 'ROUND_START' };
  }

  /**
   * Apply a player intent to the authoritative state.
   * Returns { ok: true, state, event } or { ok: false, reason }.
   */
  function applyIntent(state, seat, intent) {
    if (!intent || typeof intent.type !== 'string') {
      return { ok: false, reason: 'Invalid intent payload.' };
    }

    // Any player can vote READY_NEXT (accept or decline playing again in the same lobby) at roundEnd or matchEnd
    if (intent.type === 'READY_NEXT') {
      if (state.phase !== 'roundEnd' && state.phase !== 'matchEnd') {
        return { ok: false, reason: 'Round has not ended yet.' };
      }
      const seatObj = state.seats[seat];
      if (!seatObj) return { ok: false, reason: 'Invalid seat.' };

      const accept = intent.accept !== false;
      seatObj.readyNext = accept ? 'accepted' : 'declined';
      if (!accept && seat !== 0) {
        // Immediately mark this declined guest seat to be replaced by a bot
        const botNames = ['Alper (Bot)', 'Gamze (Bot)', 'Zeynep (Bot)', 'Mert (Bot)'];
        seatObj.isBot = true;
        seatObj.connected = true;
        seatObj.name = botNames[seat] || `Bot ${seat + 1}`;
        seatObj.seatToken = `bot-replaced-${seat}-${Date.now()}`;
      }

      state.seq++;
      state.lastAction = { type: 'READY_NEXT', seat, accept };

      // Check if all 4 seats have now responded (accepted, declined/converted to bot, or disconnected)
      const allResponded = state.seats.every((s) =>
        s.isBot || !s.connected || s.readyNext === 'accepted' || s.readyNext === 'declined'
      );
      if (allResponded && state.seats[0].readyNext === 'accepted') {
        return advanceToNextRoundOrRematch(state);
      }
      return { ok: true, state, event: 'READY_UPDATED' };
    }

    // Host can advance to next round (automatic 5s timer when totalRounds > 1, or force-start replacing waiting players)
    if (intent.type === 'NEXT_ROUND') {
      if (state.phase !== 'roundEnd' && state.phase !== 'matchEnd') {
        return { ok: false, reason: 'Round has not ended yet.' };
      }
      state.seats[0].readyNext = 'accepted';
      return advanceToNextRoundOrRematch(state, Boolean(intent.forceReplaceWaiting));
    }

    if (state.phase !== 'playing') {
      return { ok: false, reason: 'Game is not currently in an active round.' };
    }
    if (seat !== state.currentTurn) {
      return { ok: false, reason: 'It is not your turn.' };
    }

    const player = state.seats[seat];

    switch (intent.type) {
      case 'DRAW_STOCK': {
        if (state.turnPhase !== 'draw') {
          return { ok: false, reason: 'You have already drawn this turn.' };
        }
        if (state.drawPile.length === 0) {
          return { ok: false, reason: 'Draw pile is empty.' };
        }
        const drawn = state.drawPile.shift();
        player.rack.push(drawn);
        player.mustOpenWithTileId = null;
        player.takenDiscardTileId = null;
        state.turnPhase = 'act';
        state.seq++;
        state.lastAction = { type: 'DRAW_STOCK', seat, tileId: drawn.id };
        return { ok: true, state, drawnTile: drawn };
      }

      case 'TAKE_DISCARD': {
        if (state.turnPhase !== 'draw') {
          return { ok: false, reason: 'You can only take the discard at the start of your turn.' };
        }
        const prev = state.seats[previousSeat(seat)];
        if (prev.discardPile.length === 0) {
          return { ok: false, reason: 'There is no discard tile available to take.' };
        }
        const taken = prev.discardPile.pop();
        player.rack.push(taken);
        player.takenDiscardTileId = taken.id;
        // Rule: If the player has not opened yet, the taken discard MUST be used in an opening this turn
        player.mustOpenWithTileId = player.openedMode === null ? taken.id : null;
        state.turnPhase = 'act';
        state.seq++;
        state.lastAction = { type: 'TAKE_DISCARD', seat, fromSeat: prev.seat, tile: taken };
        return { ok: true, state, takenTile: taken };
      }

      case 'RETURN_DISCARD': {
        // Allows a player who took the previous player's discard to put it back if it is still in their rack
        const returnId = player.takenDiscardTileId != null ? player.takenDiscardTileId : player.mustOpenWithTileId;
        if (state.turnPhase !== 'act' || returnId == null) {
          return { ok: false, reason: 'No taken discard tile to put back.' };
        }
        const idx = player.rack.findIndex((t) => t.id === returnId);
        if (idx === -1) {
          return { ok: false, reason: 'Taken discard tile was already played onto the table.' };
        }
        const [returned] = player.rack.splice(idx, 1);
        player.mustOpenWithTileId = null;
        player.takenDiscardTileId = null;
        const prev = state.seats[previousSeat(seat)];
        prev.discardPile.push(returned);
        state.turnPhase = 'draw';
        state.seq++;
        state.lastAction = { type: 'RETURN_DISCARD', seat, toSeat: prev.seat, tile: returned };
        return { ok: true, state, returnedTile: returned };
      }

      case 'OPEN_MELDS': {
        if (state.turnPhase !== 'act') {
          return { ok: false, reason: 'You must draw or take the discard before playing melds.' };
        }
        if (!Array.isArray(intent.melds) || intent.melds.length === 0) {
          return { ok: false, reason: 'Provide at least one meld.' };
        }

        // Map tile IDs to actual tiles in player's rack
        const rackMap = new Map(player.rack.map((t) => [t.id, t]));
        const meldTileGroups = [];
        const usedIds = new Set();

        for (const idGroup of intent.melds) {
          if (!Array.isArray(idGroup) || idGroup.length < 2) {
            return { ok: false, reason: 'Each meld must have at least 2 tiles.' };
          }
          const groupTiles = [];
          for (const rawId of idGroup) {
            const tid = Number(rawId);
            if (usedIds.has(tid)) {
              return { ok: false, reason: 'A tile cannot be used in two melds at once.' };
            }
            const tile = rackMap.get(tid);
            if (!tile) {
              return { ok: false, reason: `Tile #${tid} is not in your rack.` };
            }
            usedIds.add(tid);
            groupTiles.push(tile);
          }
          meldTileGroups.push(groupTiles);
        }

        // Player must always retain at least 1 tile in their rack to discard at end of turn
        if (usedIds.size >= player.rack.length) {
          return { ok: false, reason: 'You must keep at least 1 tile in your rack to discard.' };
        }

        if (player.openedMode === null) {
          // First time opening: enforce mustOpenWithTileId if they took a discard
          if (player.mustOpenWithTileId != null && !usedIds.has(player.mustOpenWithTileId)) {
            return {
              ok: false,
              reason: 'You took the previous discard while unopened — you must include that tile in your opening melds.'
            };
          }

          const openRes = validateOpening(meldTileGroups, state.indicator, state.config);
          if (!openRes.valid) {
            return { ok: false, reason: openRes.reason };
          }

          player.openedMode = openRes.mode;
          player.mustOpenWithTileId = null;
          if (player.takenDiscardTileId != null && usedIds.has(player.takenDiscardTileId)) {
            player.takenDiscardTileId = null;
          }
          player.rack = player.rack.filter((t) => !usedIds.has(t.id));

          for (const m of openRes.melds) {
            state.tableMelds.push({
              id: state.nextMeldId++,
              ownerSeat: seat,
              kind: m.kind,
              tiles: m.orderedTiles,
              points: m.points
            });
          }

          state.seq++;
          state.lastAction = {
            type: 'OPEN_MELDS',
            seat,
            mode: openRes.mode,
            totalPoints: openRes.totalPoints,
            meldCount: openRes.melds.length
          };
          return { ok: true, state, mode: openRes.mode, totalPoints: openRes.totalPoints };
        } else {
          // Player has ALREADY opened earlier -> laying down additional new melds from hand
          const validated = [];
          for (const group of meldTileGroups) {
            const res = validateMeld(group, state.indicator, state.config);
            if (!res.valid) {
              return { ok: false, reason: res.reason };
            }
            if (player.openedMode === 'pairs' && res.kind !== 'pair') {
              return { ok: false, reason: 'You opened with pairs, so you can only lay down new pairs.' };
            }
            if (player.openedMode === 'sets' && res.kind === 'pair') {
              return { ok: false, reason: 'You opened with sets/runs, so you cannot lay down pairs.' };
            }
            validated.push(res);
          }

          if (player.takenDiscardTileId != null && usedIds.has(player.takenDiscardTileId)) {
            player.takenDiscardTileId = null;
          }
          player.rack = player.rack.filter((t) => !usedIds.has(t.id));
          for (const m of validated) {
            state.tableMelds.push({
              id: state.nextMeldId++,
              ownerSeat: seat,
              kind: m.kind,
              tiles: m.orderedTiles,
              points: m.points
            });
          }

          state.seq++;
          state.lastAction = {
            type: 'ADD_MELDS',
            seat,
            meldCount: validated.length
          };
          return { ok: true, state };
        }
      }

      case 'LAY_OFF': {
        if (state.turnPhase !== 'act') {
          return { ok: false, reason: 'You must draw before laying off tiles.' };
        }
        if (player.openedMode === null) {
          return { ok: false, reason: 'You must open your hand before laying off onto table melds.' };
        }
        const meldId = Number(intent.meldId);
        const targetMeld = state.tableMelds.find((m) => m.id === meldId);
        if (!targetMeld) {
          return { ok: false, reason: 'Target table meld not found.' };
        }

        const tileIds = Array.isArray(intent.tileIds) ? intent.tileIds.map(Number) : [Number(intent.tileId)];
        if (tileIds.length === 0 || tileIds.some((id) => !id)) {
          return { ok: false, reason: 'Select at least one tile to lay off.' };
        }

        const rackMap = new Map(player.rack.map((t) => [t.id, t]));
        const tilesToAdd = [];
        const usedIds = new Set();
        for (const tid of tileIds) {
          if (usedIds.has(tid)) return { ok: false, reason: 'Duplicate tile in lay-off.' };
          const tile = rackMap.get(tid);
          if (!tile) return { ok: false, reason: `Tile #${tid} is not in your rack.` };
          usedIds.add(tid);
          tilesToAdd.push(tile);
        }

        const res = validateLayOff(targetMeld, tilesToAdd, state.indicator, state.config);
        if (!res.valid) {
          return { ok: false, reason: res.reason };
        }

        // Player must retain at least 1 tile in their rack to discard (unless retrieving an Okey, which swaps 1-for-1)
        const netRackReduction = tileIds.length - (res.retrievedOkey ? 1 : 0);
        if (netRackReduction >= player.rack.length) {
          return { ok: false, reason: 'You must keep at least 1 tile in your rack to discard.' };
        }

        if (player.takenDiscardTileId != null && usedIds.has(player.takenDiscardTileId)) {
          player.takenDiscardTileId = null;
        }
        player.rack = player.rack.filter((t) => !usedIds.has(t.id));
        if (res.retrievedOkey) {
          player.rack.push(res.retrievedOkey);
        }
        targetMeld.tiles = res.orderedTiles;
        targetMeld.points = res.points;

        state.seq++;
        state.lastAction = {
          type: 'LAY_OFF',
          seat,
          meldId: targetMeld.id,
          tiles: tilesToAdd,
          retrievedOkey: res.retrievedOkey || null
        };
        return { ok: true, state, retrievedOkey: res.retrievedOkey || null };
      }

      case 'DISCARD': {
        if (state.turnPhase !== 'act') {
          return { ok: false, reason: 'You must draw or take the discard before discarding.' };
        }
        if (player.mustOpenWithTileId != null) {
          return {
            ok: false,
            reason: 'You took the discard while unopened — you must open with it or return it first.'
          };
        }

        const tileId = Number(intent.tileId);
        const idx = player.rack.findIndex((t) => t.id === tileId);
        if (idx === -1) {
          return { ok: false, reason: 'Selected discard tile is not in your rack.' };
        }

        const [discarded] = player.rack.splice(idx, 1);
        player.takenDiscardTileId = null;
        player.discardPile.push(discarded);
        const discardedIsOkey = isOkeyTile(discarded, state.indicator);

        // Check if player just went out (0 tiles left in rack)
        if (player.rack.length === 0) {
          finalizeRound(state, {
            endReason: 'go_out',
            winnerSeat: seat,
            wonWithOkey: discardedIsOkey,
            wonWithPairs: player.openedMode === 'pairs'
          });
          state.seq++;
          state.lastAction = {
            type: 'GO_OUT',
            seat,
            tile: discarded,
            wonWithOkey: discardedIsOkey
          };
          return { ok: true, state, roundEnded: true };
        }

        // Penalty for discarding an Okey without going out (Pagat: +101 penalty)
        if (discardedIsOkey) {
          player.penaltyAdjust += state.config.DISCARD_OKEY_PENALTY;
        }

        // Check if draw pile is now empty after this turn -> round ends by stock exhaustion
        if (state.drawPile.length === 0) {
          finalizeRound(state, {
            endReason: 'stock_exhausted',
            winnerSeat: null,
            wonWithOkey: false,
            wonWithPairs: false
          });
          state.seq++;
          state.lastAction = {
            type: 'STOCK_EXHAUSTED',
            seat,
            tile: discarded
          };
          return { ok: true, state, roundEnded: true };
        }

        // Advance turn counter-clockwise
        state.currentTurn = nextSeat(seat);
        state.turnPhase = 'draw';
        state.seq++;
        state.lastAction = {
          type: 'DISCARD',
          seat,
          tile: discarded,
          nextTurn: state.currentTurn
        };
        return { ok: true, state, roundEnded: false };
      }

      default:
        return { ok: false, reason: `Unknown intent type "${intent.type}".` };
    }
  }

  // ---------------------------------------------------------------------------
  // Round Scoring & Penalty Calculation (Pagat.com Okey 101 Table)
  // ---------------------------------------------------------------------------
  function calculateHandTilePoints(rack, indicator, config) {
    const cfg = config || SCORING_CONFIG;
    let sum = 0;
    for (const tile of rack) {
      if (isOkeyTile(tile, indicator)) {
        sum += cfg.UNPLAYED_OKEY_HAND_VALUE; // 101 points per unplayed Okey
      } else {
        const eff = getEffectiveTile(tile, indicator);
        sum += eff.number;
      }
    }
    return sum;
  }

  function finalizeRound(state, outcome) {
    const cfg = state.config || SCORING_CONFIG;
    let ruleRow;

    if (outcome.endReason === 'stock_exhausted' || outcome.winnerSeat == null) {
      ruleRow = cfg.STOCK_EXHAUSTED;
    } else if (!outcome.wonWithPairs && !outcome.wonWithOkey) {
      ruleRow = cfg.SCENARIO_A;
    } else if (!outcome.wonWithPairs && outcome.wonWithOkey) {
      ruleRow = cfg.SCENARIO_B;
    } else if (outcome.wonWithPairs && !outcome.wonWithOkey) {
      ruleRow = cfg.SCENARIO_C;
    } else {
      ruleRow = cfg.SCENARIO_D;
    }

    const roundScores = [];
    for (let s = 0; s < 4; s++) {
      const seatObj = state.seats[s];
      let score = 0;
      if (outcome.winnerSeat === s) {
        score = ruleRow.winnerBonus + seatObj.penaltyAdjust;
      } else if (seatObj.openedMode === null) {
        score = ruleRow.unopenedPenalty + seatObj.penaltyAdjust;
      } else {
        const rawHand = calculateHandTilePoints(seatObj.rack, state.indicator, cfg);
        const mult = seatObj.openedMode === 'pairs'
          ? ruleRow.openedPairsMultiplier
          : ruleRow.openedSetsMultiplier;
        score = rawHand * mult + seatObj.penaltyAdjust;
      }
      seatObj.roundScore = score;
      seatObj.totalScore += score;
      seatObj.readyNext = seatObj.isBot ? 'accepted' : (!seatObj.connected ? 'declined' : null);
      roundScores.push(score);
    }

    state.winnerSeat = outcome.winnerSeat;
    state.roundHistory.push({
      roundIndex: state.roundIndex,
      endReason: outcome.endReason,
      winnerSeat: outcome.winnerSeat,
      wonWithOkey: Boolean(outcome.wonWithOkey),
      wonWithPairs: Boolean(outcome.wonWithPairs),
      scores: roundScores
    });

    if (state.roundIndex + 1 >= state.totalRounds) {
      state.phase = 'matchEnd';
      // Lowest total score wins
      let bestSeat = 0;
      for (let s = 1; s < 4; s++) {
        if (state.seats[s].totalScore < state.seats[bestSeat].totalScore) {
          bestSeat = s;
        }
      }
      state.matchWinnerSeat = bestSeat;
    } else {
      state.phase = 'roundEnd';
    }
  }

  // ---------------------------------------------------------------------------
  // Simple Legal-Move Bot AI & Timeout Auto-Play
  // ---------------------------------------------------------------------------
  function chooseSafeDiscardTile(rack, indicator) {
    // Never discard an Okey unless it is the only tile in hand
    const nonOkeys = rack.filter((t) => !isOkeyTile(t, indicator));
    const pool = nonOkeys.length > 0 ? nonOkeys : rack;
    // Prefer discarding highest number tile that isn't part of a pair
    const counts = new Map();
    for (const t of pool) {
      const eff = getEffectiveTile(t, indicator);
      const key = `${eff.color}:${eff.number}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const sorted = pool.slice().sort((a, b) => {
      const ea = getEffectiveTile(a, indicator);
      const eb = getEffectiveTile(b, indicator);
      const ca = counts.get(`${ea.color}:${ea.number}`) || 1;
      const cb = counts.get(`${eb.color}:${eb.number}`) || 1;
      if (ca !== cb) return ca - cb; // singletons first
      return eb.number - ea.number;  // highest face value first to minimize hand penalty
    });
    return sorted[0];
  }

  /**
   * Computes and executes the next legal step for `seat` (used for bots and turn timeout).
   * Note: Bots cannot open their hands; they only draw tiles from the center pile and discard tiles.
   */
  function runBotTurn(state, seat) {
    if (state.phase !== 'playing' || state.currentTurn !== seat) {
      return { ok: false, reason: 'Not this seat\'s active turn.' };
    }
    const player = state.seats[seat];
    const actions = [];

    // If an unopened human timed out after taking a discard they didn't open with, return it first
    if (state.turnPhase === 'act' && player.mustOpenWithTileId != null) {
      const r = applyIntent(state, seat, { type: 'RETURN_DISCARD' });
      if (r.ok) actions.push({ type: 'RETURN_DISCARD' });
    }

    // Step 1: Draw from center pile only
    if (state.turnPhase === 'draw') {
      const drawRes = applyIntent(state, seat, { type: 'DRAW_STOCK' });
      if (!drawRes.ok) return drawRes;
      actions.push({ type: 'DRAW_STOCK' });
    }

    // Step 2: Discard a safe tile (bots do not open their hands)
    if (state.turnPhase === 'act') {
      const discardTile = chooseSafeDiscardTile(player.rack, state.indicator);
      const discRes = applyIntent(state, seat, { type: 'DISCARD', tileId: discardTile.id });
      if (!discRes.ok) return discRes;
      actions.push({ type: 'DISCARD', tileId: discardTile.id });
    }

    return { ok: true, state, actions };
  }

  // ---------------------------------------------------------------------------
  // Hidden-Information State Projections (CRITICAL PRIVACY BOUNDARY)
  // ---------------------------------------------------------------------------
  /**
   * Produces the public state safe to broadcast to all players.
   * NEVER includes any player's `rack`, `seatToken`, or the `drawPile` tile list.
   */
  function getPublicState(state) {
    return {
      version: state.version,
      seq: state.seq,
      roomCode: state.roomCode,
      phase: state.phase,
      roundIndex: state.roundIndex,
      totalRounds: state.totalRounds,
      starterSeat: state.starterSeat,
      currentTurn: state.currentTurn,
      turnPhase: state.turnPhase,
      turnDeadlineMs: state.turnDeadlineMs,
      indicator: state.indicator ? Object.assign({}, state.indicator) : null,
      okeySpec: state.okeySpec ? Object.assign({}, state.okeySpec) : null,
      drawPileCount: state.drawPile.length,
      tableMelds: state.tableMelds.map((m) => ({
        id: m.id,
        ownerSeat: m.ownerSeat,
        kind: m.kind,
        points: m.points,
        tiles: m.tiles.map((t) => Object.assign({}, t))
      })),
      seats: state.seats.map((s) => ({
        seat: s.seat,
        name: s.name,
        isBot: s.isBot,
        connected: s.connected,
        tileCount: s.rack.length,
        openedMode: s.openedMode,
        discardPile: s.discardPile.map((t) => Object.assign({}, t)),
        roundScore: s.roundScore,
        totalScore: s.totalScore,
        penaltyAdjust: s.penaltyAdjust,
        rawHandPoints: (state.phase === 'roundEnd' || state.phase === 'matchEnd') && state.indicator
          ? calculateHandTilePoints(s.rack, state.indicator, state.config)
          : 0,
        readyNext: s.readyNext,
        mustOpenWithDiscard: s.mustOpenWithTileId != null
      })),
      lastAction: state.lastAction ? Object.assign({}, state.lastAction) : null,
      winnerSeat: state.winnerSeat,
      matchWinnerSeat: state.matchWinnerSeat,
      roundHistory: state.roundHistory.map((h) => Object.assign({}, h, { scores: h.scores.slice() })),
      config: state.config
    };
  }

  /**
   * Produces the private rack payload for a single recipient seat ONLY.
   */
  function getPrivateRack(state, seat) {
    const s = state.seats[seat];
    if (!s) return null;
    return {
      seat: s.seat,
      rack: s.rack.map((t) => Object.assign({}, t)),
      mustOpenWithTileId: s.mustOpenWithTileId,
      takenDiscardTileId: s.takenDiscardTileId
    };
  }

  /**
   * Combined personalized sync payload sent exclusively to `seat`.
   */
  function getStateSyncForSeat(state, seat) {
    return {
      v: 1,
      seq: state.seq,
      type: 'STATE_SYNC',
      seat,
      publicState: getPublicState(state),
      privateRack: getPrivateRack(state, seat)
    };
  }

  return {
    COLORS,
    SCORING_CONFIG,
    createRng,
    createDeck,
    shuffleDeck,
    getOkeySpec,
    isOkeyTile,
    getEffectiveTile,
    validatePair,
    validateSet,
    validateRun,
    validateMeld,
    validateOpening,
    validateLayOff,
    sortRackByRuns,
    sortRackBySets,
    findIslePlan,
    findBestMeldsInRack,
    chooseSafeDiscardTile,
    createGameState,
    startRound,
    applyIntent,
    calculateHandTilePoints,
    runBotTurn,
    getPublicState,
    getPrivateRack,
    getStateSyncForSeat
  };
});


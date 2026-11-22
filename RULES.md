# 101 Okey — Rules & Variant Assumptions

This document specifies the exact rules implemented in [engine.js](file:///Users/kondormustafakilic/Downloads/p2ptest/engine.js), cross-checked against **[Pagat.com — Okey 101](https://www.pagat.com/rummy/okey101.html)**. Because regional and online variants of 101 Okey differ, every design choice and penalty constant is listed below.

---

## 1. Equipment & Tile Definitions

* **106 Tiles Total:**
  * 4 colors: **Red** (`red`), **Yellow** (`yellow`), **Blue** (`blue`), **Black** (`black`).
  * Numbers `1` through `13` in each color, with **2 copies** of each tile ($4 \times 13 \times 2 = 104$ numbered tiles).
  * **2 Fake Jokers** (`Sahte Okey`, labeled `FJ`).
* **Indicator (`Gösterge`) & Okey (Wild Joker):**
  * After shuffling, 1 tile is turned face-up as the **Indicator**. If a Fake Joker is drawn as the indicator, it is shuffled back and another tile is drawn until a numbered tile appears.
  * The **Okey (Wild)** is the tile of the **same color** and **next higher number** (`indicator.number + 1`, where `13` wraps to `1`).
  * Both copies of the Okey tile act as wildcards and can substitute for any color and number in a run, set, or pair.
  * Both **Fake Jokers** cease to be wild and act strictly as ordinary tiles having the exact color and number of the active Okey tile.

---

## 2. Deal & Turn Structure

* **4 Players** seated at seats `0`, `1`, `2`, `3` in counter-clockwise order (`0 → 1 → 2 → 3 → 0`).
* **Deal:**
  * The starting player (`starterSeat = roundIndex % 4`) receives **22 tiles**.
  * The other three players each receive **21 tiles**.
  * 1 tile is face-up as the Indicator.
  * The remaining **20 tiles** form the face-down center draw pile (`stock`).
* **Starter's First Turn:**
  * The starting player begins in the `'act'` phase with 22 tiles: they do not draw on their first turn. They may optionally open/lay off melds and then discard 1 tile to end their turn (reducing their rack to 21 tiles).
* **Subsequent Turns:**
  1. **Draw Phase (`'draw'`):** The active player must either:
     * **Draw 1 tile** face-down from the center draw pile (`DRAW_STOCK`), **or**
     * **Take the previous player's top discard** (`TAKE_DISCARD`).
  2. **Taken-Discard Restriction for Unopened Players:**
     * If the player has **not opened yet**, they may take the previous player's discard **only if they open on that exact turn and include the taken discard tile in one of their opening melds**.
     * If they stage tiles and realize they cannot reach 101 points (or 5 pairs), they can click **Undo Take Discard** (`RETURN_DISCARD`) to put the tile back and draw from the center pile instead. The engine forbids discarding without opening when a taken discard is held by an unopened player.
  3. **Action & Discard Phase (`'act'`):**
     * The player may open their hand (if unopened), lay down additional melds, or lay off tiles onto existing table melds.
     * The player must always keep **at least 1 tile** in their rack so they can discard a tile to finish their turn (`DISCARD`).

---

## 3. Valid Melds & Opening Rules

* **Set (`Per`):** 3 or 4 tiles of the **same number** and **all distinct colors** (e.g., Red 7, Blue 7, Black 7). Duplicate colors in a set are invalid.
* **Run (`Seri`):** 3 or more consecutive numbers of the **same color** (e.g., Blue 4, Blue 5, Blue 6).
  * **`ALLOW_HIGH_ACE = false`:** `1` is low only (`1-2-3` is valid; `12-13-1` is invalid).
* **Pair (`Çift`):** 2 identical tiles of the **same color and same number** (e.g., Yellow 9 + Yellow 9, or any tile + an Okey wildcard).
* **Opening Options:**
  1. **Series Opening (`sets` mode):** Lay down one or more valid sets and/or runs in a single turn whose face values (using the represented number for any Okey wildcard in a meld) total **$\ge 101$ points**.
  2. **Pairs Opening (`pairs` mode):** Lay down **at least 5 pairs** in a single turn (total face value does not matter).
* **No Mixing Rule:**
  * A player cannot mix pairs with sets/runs when opening.
  * A player who opens with pairs can only lay down new pairs from their hand for the rest of the round. A player who opens with sets/runs can only lay down new sets/runs.
  * **Laying Off (`İşleme`):** Per Pagat rules, **any** player who has already opened (whether via sets/runs or via pairs) may lay off matching tiles from their rack onto existing sets and runs on the table.
* **Joker Retrieval (`ALLOW_OKEY_RETRIEVAL = true`):**
  * If a meld on the table contains a wild Okey (for example, `8, 9, Okey, 11`) and an opened player has the exact tile that the Okey represents (`10` of that color), laying off that tile onto the meld swaps the `10` into the meld and **gives the Okey tile to the player's rack**.

---

## 4. Round End & Single Authoritative Scoring Table

All scoring and penalty constants are defined in a single frozen configuration object `SCORING_CONFIG` in [engine.js](file:///Users/kondormustafakilic/Downloads/p2ptest/engine.js#L22-L76), directly implementing the **[Pagat.com Okey 101 Scoring Table](https://www.pagat.com/rummy/okey101.html)**:

| Scenario | Winner Score | Unopened Player Penalty | Opened with Sets/Runs Penalty | Opened with Pairs Penalty |
| :--- | :---: | :---: | :---: | :---: |
| **A. Winner opened Sets/Runs, normal final discard** | **$-101$** | **$+202$** | $1 \times \text{hand sum}$ | $2 \times \text{hand sum}$ |
| **B. Winner opened Sets/Runs, discarded Okey to win** | **$-202$** | **$+404$** | $2 \times \text{hand sum}$ | $4 \times \text{hand sum}$ |
| **C. Winner opened Pairs, normal final discard** | **$-202$** | **$+404$** | $2 \times \text{hand sum}$ | $4 \times \text{hand sum}$ |
| **D. Winner opened Pairs, discarded Okey to win** | **$-404$** | **$+404$** | $4 \times \text{hand sum}$ | $8 \times \text{hand sum}$ |
| **E. Draw Pile Exhausted (no one goes out)** | **$0$** | **$+202$** | $1 \times \text{hand sum}$ | $2 \times \text{hand sum}$ |

### Special Joker (Okey) Penalties (Pagat.com)
* **Unplayed Okey Left in Hand (`UNPLAYED_OKEY_HAND_VALUE = 101`):** Any unplayed real Okey tile remaining in an opened player's rack at the end of the round counts as **101 points** toward their hand sum before the scenario multiplier is applied.
* **Discarding an Okey Mid-Round (`DISCARD_OKEY_PENALTY = 101`):** If a player discards a real Okey tile without going out on that discard, they immediately receive **+101 penalty points** added to their round score.
* **Match Winner:** After the configured number of rounds (default **3 rounds**), the player with the **lowest cumulative score** wins.


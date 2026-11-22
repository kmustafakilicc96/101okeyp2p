# 101 Okey P2P (4-Player WebRTC Tile Game)

A 4-player online **101 Okey** game built with plain HTML, CSS, and JavaScript. It is **free to host as static files**, uses a **host-authoritative star topology** over reliable WebRTC DataChannels, and enforces **hidden-information privacy** so no player's client ever receives another player's rack or the face-down draw pile order.

* **Full Rules & Pagat.com Scoring Table:** See [RULES.md](file:///Users/kondormustafakilic/Downloads/p2ptest/RULES.md).

---

## 1. Run Locally (LAN or Single Machine)

Requires **Node.js 22+** (zero external npm packages to install).

```bash
npm start
# or: node server.js
```

To stop the server:
* Press **`Ctrl + C`** in the terminal where it is running, or run `kill $(lsof -ti :3000)`.

When running locally:
1. Open `http://localhost:3000/?transport=localws` (or select **Local WebSocket Signaling** in the P2P Discovery Mode dropdown).
2. Click **Create Lobby**. Share the 6-character code or click **Copy Invite Link**.
3. Up to 3 other devices on the same Wi-Fi can open the LAN URL printed in the terminal (`http://<LAN_IP>:3000/?transport=localws#<CODE>`) and join.
4. Empty seats can be automatically filled with legal-move AI bots via the **"Fill empty seats with bots on start"** toggle.

---

## 2. Deploy for Free as Static Files (Cross-Network / Internet)

In production, the game requires **zero backend server**. By default, it uses **`TrysteroTransport`** (pinned to `trystero@0.20.1` from CDN), which uses public relays solely for WebRTC SDP/ICE peer discovery and then sends all gameplay traffic directly over encrypted WebRTC DataChannels.

You can deploy the static files ([index.html](file:///Users/kondormustafakilic/Downloads/p2ptest/index.html), [style.css](file:///Users/kondormustafakilic/Downloads/p2ptest/style.css), [strings.js](file:///Users/kondormustafakilic/Downloads/p2ptest/strings.js), [engine.js](file:///Users/kondormustafakilic/Downloads/p2ptest/engine.js), [transport.js](file:///Users/kondormustafakilic/Downloads/p2ptest/transport.js), [network.js](file:///Users/kondormustafakilic/Downloads/p2ptest/network.js), [game.js](file:///Users/kondormustafakilic/Downloads/p2ptest/game.js), [RULES.md](file:///Users/kondormustafakilic/Downloads/p2ptest/RULES.md)) for free on:

* **Netlify:** Drag and drop the project folder onto [app.netlify.com/drop](https://app.netlify.com/drop) or connect your Git repository (no build command, publish directory `.`).
* **Cloudflare Pages:** Create a Pages project from your repository or upload the folder with `npx wrangler pages deploy .`.
* **GitHub Pages:** Push the repository to GitHub and enable **Settings → Pages → Deploy from branch (`main`, `/root`)**.

---

## 3. Optional TURN Setup (Cloudflare Free TURN Tier)

Most home Wi-Fi networks connect directly via the built-in public STUN servers (`stun.l.google.com:19302`, `stun.cloudflare.com:3478`). However, **cellular 4G/5G networks** and strict symmetric NATs often block direct UDP hole-punching and require a **TURN relay**.

### Using Cloudflare Calls Free TURN Tier (No Hardcoded Secrets)
1. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), go to **Calls → TURN Keys** (free tier includes 1,000 GB/month).
2. Create a TURN Key and generate short-lived credentials via the Cloudflare API on your own machine:
   ```bash
   curl -X POST "https://rtc.live.cloudflare.com/v1/turn/keys/<TURN_KEY_ID>/credentials/generate" \
     -H "Authorization: Bearer <TURN_API_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"ttl": 86400}'
   ```
3. The response gives you `urls` (`turns:turn.cloudflare.com:5349`), `username`, and `credential`.
4. Before creating or joining a lobby, expand **"Optional TURN Server"** on the main menu and paste the `TURN URL`, `Username`, and `Credential`. Never commit your `<TURN_API_TOKEN>` into client-side code.

---

## 4. How to Play

1. **Create or Join:**
   * **Host (Seat 1):** Enter your name, pick rounds (1/3/5) and turn timer (30s/60s/90s), and click **Create Lobby**.
   * **Guests (Seats 2–4):** Open the host's `#CODE` invite link or enter the 6-character code and click **Join Lobby**.
   * Click **Start 101 Okey** when ready (empty seats become bots if the toggle is checked).
2. **On Your Turn:**
   * **Draw Phase:** Click **Draw Tile** to draw from the center pile, or click **Take Discard** (or tap the highlighted previous player's discard pile) to take the last discarded tile.
     * *Rule:* If you have **not opened yet**, a taken discard **must** be used in your opening on that turn. If you cannot reach 101 points (or 5 pairs), click **Undo Take Discard** to return it and draw from the center pile instead.
   * **Staging & Opening (101+ Points or 5+ Pairs):**
     * Your 2-row rack holds up to 28 slots. Use **Sort: Runs (1-2-3)** or **Sort: Sets (7-7-7)** to organize your hand, or click **Suggest Melds** to auto-stage valid groups.
     * Drag tiles into the **Staged Melds** boxes (or tap a tile to select it, then tap a Staged Meld box / double-tap the tile).
     * The live badge shows your current staged points (`104 / 101 pts ✓` or `5 / 5 pairs ✓`). Click **Play Staged Melds** to place them on the table.
   * **Laying Off (`İşleme`):**
     * Once you have opened, tap a tile in your rack to select it, then tap any matching **Table Meld** (or drag the tile onto the table meld) to lay it off.
   * **Discarding:**
     * Select 1 tile in your rack and click **Discard Selected Tile** to end your turn.
3. **Reconnecting:**
   * Each seat has a secret token stored in `localStorage`. Refreshing the page or rejoining with the same browser automatically reclaims your seat and restores your rack.
   * The Host persists full authoritative state to `localStorage` after every move; refreshing the Host page resumes the match automatically.

---

## 5. Project Structure

| File | Purpose |
|---|---|
| [engine.js](file:///Users/kondormustafakilic/Downloads/p2ptest/engine.js) | Pure, deterministic 101 Okey engine, `SCORING_CONFIG`, bot AI, and hidden-information state projections |
| [strings.js](file:///Users/kondormustafakilic/Downloads/p2ptest/strings.js) | Complete English (`EN`) and Turkish (`TR`) UI localization dictionary |
| [transport.js](file:///Users/kondormustafakilic/Downloads/p2ptest/transport.js) | Unified P2P transport interface with `TrysteroTransport` (CDN v0.20.1) and `LocalWsTransport` |
| [game.js](file:///Users/kondormustafakilic/Downloads/p2ptest/game.js) | Host-authoritative game controller, `localStorage` persistence, seat-token rejoin, and 2-row rack UI |
| [index.html](file:///Users/kondormustafakilic/Downloads/p2ptest/index.html) | Mobile-first dark UI layout (Menu, 4-Seat Lobby, Game Table, Scoreboard, Diagnostics) |
| [style.css](file:///Users/kondormustafakilic/Downloads/p2ptest/style.css) | Responsive dark styling, tile rendering, and 2-row rack layout |
| [server.js](file:///Users/kondormustafakilic/Downloads/p2ptest/server.js) | Local HTTP static server + 4-seat WebSocket signaling server for LAN & automated testing |
| [RULES.md](file:///Users/kondormustafakilic/Downloads/p2ptest/RULES.md) | Detailed 101 Okey rules, variant choices, and Pagat.com penalty/scoring table |
| [test/engine.test.js](file:///Users/kondormustafakilic/Downloads/p2ptest/test/engine.test.js) | 55 unit & privacy tests covering rules, scoring, 4-bot seeded game, and zero hidden-info leaks |
| [test/signaling.test.js](file:///Users/kondormustafakilic/Downloads/p2ptest/test/signaling.test.js) | 4-seat WebSocket signaling & security checks |
| [test/e2e-webrtc.test.js](file:///Users/kondormustafakilic/Downloads/p2ptest/test/e2e-webrtc.test.js) | 4-context headless Chrome CDP test (full round, mid-round guest kill & rejoin, host refresh resume, wire privacy) |
| [test/trystero-smoke.test.js](file:///Users/kondormustafakilic/Downloads/p2ptest/test/trystero-smoke.test.js) | Best-effort smoke test for `TrysteroTransport` |

---

## 6. Running the Automated Tests

```bash
# 1. Run pure engine unit tests + 66-message hidden-information privacy test (no server needed)
npm run test:unit

# 2. Start local signaling server, then run signaling + 4-browser WebRTC E2E tests
npm start
npm run test:signaling
npm run test:e2e
npm run test:trystero
```

# ONLINE mode — agent protocol (Socket.IO + Nostr zap)

This document matches **`marspayTS` as implemented**: `src/socket/onlineRoom.ts`, `src/state/onlineRoomState.ts`, `src/game/onlineEngine.ts`, and zap handling in `src/calls/NDK/subscribeEvent.ts`.

Types: `chain-duel/chain-duel-react/src/types/socket.ts` (`OnlineRoomState`, `OnlineRoomSnapshot`, …).

---

## Game rules (authoritative ONLINE)

This is what the server actually simulates (`src/game/onlineEngine.ts`). Clients and bots should **treat `onlineRoomSnapshot` as truth**, not re-simulate unless fuzz-testing.

### Stakes and win condition

- Each seat’s paid amount (and buy-in defaults) set **`initialScore` / `score`** and **`totalPoints`** = sum of both players’ starting points. **Scores always stay between 0 and `totalPoints`**; taking from one side adds to the other (zero-sum pool).
- **Match ends** when **`score[0] <= 0` or `score[1] <= 0`** after a tick (`gameEnded` becomes true; winner is the player still above zero). There is no time limit in engine code beyond room-level cleanup elsewhere.

### Map and entities

- **Grid:** `state.cols` x `state.rows` (implementation constants: **51** columns, **25** rows). Origin and bounds checks use integer cell indices; going out of bounds **resets** that snake (see below).
- **Snakes:** `state.p1` / `state.p2` each have `head`, `body` (chain behind the head), `dir` (current), `dirWanted` (requested).
- **Coinbases:** `state.coinbases[]` each have `pos: [x, y]` and optional `reward` (2, 4, 8, 16, or 32). Eating removes that coinbase and may spawn another at a random empty cell.

### Movement and input (`roomInput`)

- During **`playing`**, each tick the server reads **boolean held directions** per paid player from `inputBySession` and maps them with `setOnlineWantedDirection` (only one direction “wins” per tick depending on which keys are true).
- **After the match has started (`gameStarted`):** turns are constrained so you **cannot flip into illegal reversals** relative to current `dir` (classic snake-style: from `Up`/`Down` you may only switch to `Left`/`Right`, etc.). **P1** and **P2** have slightly different allowed transitions when `dir` is empty at the very start of motion.
- **Before `gameStarted` (pre-countdown / lineup):** only **P1 → Right** and **P2 → Left** are accepted as `dirWanted` so both face inward.
- Then a **countdown** runs (`countdownStart`, `countdownTicks`); when it completes, **`gameStarted`** becomes true and snakes begin stepping every tick.

### Eating a coinbase (scoring)

- When a **head** occupies the same cell as a coinbase, that player **gains** points and the opponent **loses** the same amount.
- Transfer amount = `floor(totalPoints * percent / 100)` with a **minimum of 1** sat (as implemented).
- **Percent** for a normal coinbase comes from **your snake length** (head + body segments), using bands:

| Chain length (segments) | Capture % of `totalPoints` |
|-------------------------|----------------------------|
| 1                       | 2%                         |
| 2–3                     | 4%                         |
| 4–6                     | 8%                         |
| 7–10                    | 16%                        |
| 11+                     | 32%                        |

- If the coinbase has **`reward`** (2 / 4 / 8 / 16 / 32), that value is used as the **percent** in the same formula instead of the length-based table.
- The eater’s **body grows** by one segment. **`currentCaptureP1` / `currentCaptureP2`** strings in `snapshot.state` (and HUD capture labels) reflect the **current** capture percent for that snake.

### Collisions (death / reset, not match end)

- **Head vs head** on the same cell: **both** snakes reset to default spawn poses and default wanted direction (P1 right, P2 left); capture labels reset to **2%**.
- **Head out of bounds** or **head vs any body segment** (self or enemy): that snake **resets** the same way.
- After reset, play continues until someone’s **score hits 0**.

### HUD and reading a snapshot

- **`snapshot.hud`:** `p1Points` / `p2Points` mirror `state.score`. **Widths** (`initialWidthP*`, `currentWidthP*`) are the share of the bar (0–100) each side holds of the pool — useful for agents that don’t want to parse the full grid.
- **`snapshot.state`:** Full authoritative picture: snake geometry, coinbases, `gameStarted`, `gameEnded`, `winnerPlayer` (`'P1' | 'P2'`), `winnerName`, `score`, `totalPoints`, `pointChanges` (floating combat text metadata), etc.

### Tick rate

- Simulation advances on the server **every 100 ms** while the room phase is `playing`; each step emits **`onlineRoomSnapshot`**.

---

## Constants (implementation)

| Constant | Value | Location |
|----------|-------|----------|
| Simulation tick | **100 ms** | `ONLINE_TICK_MS` in `onlineRoom.ts` |
| Join PIN TTL | **2 min** | `PIN_TTL_MS` in `onlineRoomState.ts` |
| Nostr link TTL (pubkey → session) | **15 min** | `NOSTR_LINK_TTL_MS` |
| Nostr challenge TTL | **5 min** | `NOSTR_CHALLENGE_TTL_MS` |
| Join PIN format | **4 decimal digits** | `issueJoinPin` |
| Payout fee factor | **0.95** of winner points (floor) | `ONLINE_PAYOUT_MULTIPLIER` |
| Replay max frames | **3600** | `ONLINE_REPLAY_MAX_FRAMES` |
| Minimum buy-in | **1000** sats | `ONLINE_BUYIN_MIN` (`consts/values.ts`) |
| Default buy-in (host omits amount) | **1000** sats | `ONLINE_BUYIN_DEFAULT` |

---

## Phases

`OnlineRoomState.phase` / snapshot phase:

`lobby` → `playing` → `postgame` → `finished` → (optional) reset to `lobby` after double-or-nothing + rematch zap; or `cancelled` if host cancels with no paid seats.

**Canonical client URL:** `https://game.chainduel.net/online/r/{roomCode}` — one link for players and spectators.

---

## Happy path (two players + optional spectators)

1. **Connect** with Socket.IO; receive `session` with `sessionID` ([`AGENTS.md`](./AGENTS.md)).
2. **Host:** `createOnlineRoom` → `resCreateOnlineRoom` with `roomId`, `roomCode`, `joinPin`, `pinExpiresAt`, `room`, optional `nostrMeta` (after async Kind1 publish).
3. **Guest / spectator:** `joinOnlineRoomByCode` `{ roomCode }` or `spectateOnlineRoomByCode` `{ roomCode }` when seats are full or match is live. Legacy `joinOnlineRoom` / `spectateOnlineRoom` by `roomId` still work.
4. **Kind1 / Nostr id** — To zap the **Kind1** note you need its **event id**. It is **not** only implied by “zap the note” in prose:
   - **`resCreateOnlineRoom`** / **`resJoinOnlineRoom`** include a **`room`** object; use **`room.kind1EventId`** as the Kind1 event id once the Kind1 exists.
   - **`nostrMeta`** (includes `min` buy-in, etc.) may appear at the **top level** of the response **or** under **`room.nostrMeta`** — agents should check **both** (server shape can vary).
5. **Buy seat:** Zap the published Kind1 (amount ≥ `nostrMeta.min` / Kind1 `min`) with the **join PIN** in the zap **content** (see [PIN & zap](#join-pin--nostr-zap-seat-claim)). Prefer sending **only** the 4-digit PIN as the comment (see [Battle-tested notes](#battle-tested-notes)).
6. **Seat assignment is asynchronous:** After you pay, the server processes the zap **before** emitting `onlineSeatAssigned`. Wait for **`onlineSeatAssigned`** or a paid seat on **`onlineRoomUpdated`** before assuming you are seated.
7. **Match admission (automatic):** When **both** seats are `paid` and both `sessionID`s are in `room.members`, phase becomes **`playing`** immediately (`maybeStartPaidMatch`). No lobby “ready” step.
8. **Arena start (mutual confirm):** While `phase === 'playing'` and `gameStarted === false`, each paid player sends **`onlineConfirmStart`** `{ roomId }` (client: Space/Enter on the arena). Server sets `seat.startConfirmed`; when **both** are true, **`startOnlineCountdown`** runs, then **`gameStarted`** after the 3-2-1 ticks.
9. **Play:** While `phase === 'playing'` and `gameStarted`, paid players send `roomInput` at **~80–100 ms** intervals. Server broadcasts **`onlineRoomSnapshot`** every tick.
10. **Finish:** Phase `postgame` → `onlineRoomUpdated`; all viewers on the room URL see results. Nostr reply may be published by server.
11. **Post-game:** `getOnlinePostGame` → withdrawal / Nostr payout / double-or-nothing (see [Battle-tested notes](#battle-tested-notes)).

---

## Client → server events (ONLINE)

| Event | Payload | Notes |
|-------|---------|--------|
| `createOnlineRoom` | `{ buyin?: number; hostLNAddress?: string }` | Requires `sessionID`. Host is spectator until zap. |
| `listOnlineRooms` | — | |
| `joinOnlineRoom` | `{ roomId: string }` | |
| `joinOnlineRoomByCode` | `{ roomCode: string }` | Code matched uppercase |
| `spectateOnlineRoom` | `{ roomId: string }` | |
| `spectateOnlineRoomByCode` | `{ roomCode: string }` | Preferred for live spectators |
| `onlineConfirmStart` | `{ roomId: string }` | Arena pre-start; both paid players must confirm before countdown |
| `leaveOnlineRoom` | `{ roomId?: string }` | If `roomId` given, leaves that socket.io room; always runs `leaveRoom(sessionID, { releaseSeat: true })` |
| `cancelOnlineRoom` | `{ roomId: string }` | Member only; **fails** if any seat is `paid` (`room_has_paid_seats`) |
| `getOnlineRoomState` | `{ roomId: string }` | Pushes `onlineRoomUpdated` to caller |
| `roomInput` | `{ roomId, input: { up?, down?, left?, right? } }` | **Only** while `playing`; caller must be paid player (by `sessionID` or `socket.id`) |
| `startOnlineGame` | `{ roomId: string }` | **Deprecated** — no longer starts matches; use `onlineConfirmStart` in arena |
| `onlineSetReady` | `{ roomId: string; ready: boolean }` | **Deprecated** — admission is automatic when both seats paid |
| `getOnlinePostGame` | `{ roomId: string }` | Re-joins room + updates socket mapping |
| `createOnlineWithdrawal` | `{ roomId: string }` | Winner only; LNURLw flow |
| `createOnlineNostrPayout` | `{ roomId: string }` | Winner only; needs `winnerLnAddress` on postgame |
| `onlineDoubleOrNothing` | `{ roomId: string }` | Both players vote; on agreement publishes rematch Kind1 |
| `getOnlineReplay` | `{ roomId: string; matchRound?: number }` | **`resOnlineReplay`** returns **compact-v2** (`gzipBase64` + `frameCount` + `tickMs`); client gunzips + decodes to full frames. Live room or disk **`roomId-rN`** / session; omit **`matchRound`** for latest session replay when archived |
| `listOnlineArchivedRooms` | — | Raw archive index rows only (`resListOnlineArchivedRooms`) |
| `listOnlineHistory` | — | **Preferred:** merged history (`resOnlineHistory`) — archive index **plus** `finished` rooms still in RAM; same merge rules as UI |
| `pingLatency` | ack callback `() => void` | Immediate ack for RTT; client measures `Date.now()` delta. |
| `reportOnlineRoomPing` | `{ roomId: string; latencyMs: number }` | **Paid seat only** (matches `sessionID`). Writes **`seat.pingMs`** and emits **`onlineRoomUpdated`** so all clients can show **both** players’ ping. |
| `requestOnlineNostrLinkChallenge` | `{ roomId: string }` | Room pubkey link: server issues **`challenge`** (`resOnlineNostrLinkChallenge`). If the socket has a valid **app Nostr session** for the same pubkey, the server may skip the challenge and emit **`resOnlineNostrLinkOk`** immediately — see [AGENTS_NOSTR_SESSION.md](./AGENTS_NOSTR_SESSION.md). |
| `confirmOnlineNostrLink` | `{ roomId: string; event: Nostr kind 1 }` | Signed kind **1** with **`content` = challenge**; server verifies and binds **`event.pubkey` → session** |

App-level sign-in (Config, global avatar, practice): **`requestAppNostrLinkChallenge` / `confirmAppNostrLink` / `getAppNostrSession` / `clearAppNostrSession`** and relay helpers **`getNostrProfile` / `publishSignedNostrEvent`** — documented in [AGENTS_NOSTR_SESSION.md](./AGENTS_NOSTR_SESSION.md).

> **No `sessionID`:** Most handlers no-op silently (no response) if `socket.data.sessionID` is missing. `createOnlineRoom` returns early without emitting if there is no session.

### Room phases (ONLINE)

| Phase | Meaning |
|-------|--------|
| `lobby` | Waiting for ready / rematch paid |
| `playing` | Sim running |
| `postgame` | **Match sim ended** — payout, Double or Nothing, rematch Kind1, etc. |
| `finished` | **Winner closed the round** (LNURLw created or Nostr payout chosen). Room is removed from RAM **immediately** after LNURL claim (`markOnlineRoomSettledBySession`) or after **Nostr** payout success; session JSON is written on delete. |

**`matchRound`** increments on each **lobby → playing** (match 1, 2, … for DoN rematches).

### Persistence (replay + history)

- **Per match:** when the sim ends (`playing` → **`postgame`**), the server writes **`data/online_archive/<roomId>-r<matchRound>.json`** (serialized room + replay for that round) and appends an index line (`archiveKind: 'match'`, `phase: 'postgame'`).
- **Replay (`compact-v2`):** archives and **`resOnlineReplay`** use **`{ format: 'compact-v2', tickMs, gzipBase64, frameCount }`** (gzip’d JSON: one-time header + thin per-frame rows). The **browser** gunzips and decodes via **`onlineReplayCodec.ts`** (shared with marspayTS). No legacy full-frame JSON.
- **Session (after payout):** on delete (right after settlement), **`data/online_archive/<roomId>-session.json`** is written (`archiveKind: 'session'`, `phase: 'finished'`). Legacy **`roomId.json`** from older builds is still read for fallback.
- **`getOnlineReplay`**, **`getOnlineRoomState`**, **`getOnlinePostGame`** fall back to disk when the room is not in RAM (optional **`matchRound`** for a specific stored match).
- **`listArchivedOnlineRoomsSync`** reads **`index.jsonl`** (deduped by **`archiveId`**, capped ~**400** rows). **`listOnlineHistory`** merges that with **`finished`** rooms still in RAM. Add retention/rotation later if disk grows.

---

## Server → client events (ONLINE)

| Event | Payload | When |
|-------|---------|------|
| `resCreateOnlineRoom` | `roomId`, `roomCode`, `joinPin`, `pinExpiresAt`, `nostrMeta?`, `room` | Host created. **`room.kind1EventId`** = Kind1 note id for zapping. **`nostrMeta`** may also appear on **`room.nostrMeta`** — check both. |
| `resJoinOnlineRoom` | Same shape | Join by id/code |
| `resListOnlineRooms` | `{ rooms: OnlineRoomListItem[] }` | After `listOnlineRooms`; also **broadcast** `io.emit` when room list changes |
| `resListOnlineArchivedRooms` | `{ rooms: OnlineRoomListItem[] }` | After `listOnlineArchivedRooms`; items include `archived: true`, `finishedAt`, `result`, `replay` meta |
| `resOnlineHistory` | `{ rooms: OnlineRoomListItem[] }` | After `listOnlineHistory` or broadcast with live list; merged archive + live-finished |
| `onlineRoomUpdated` | `OnlineRoomState` | Room membership, seats, phase, postgame fields, etc. |
| `onlineRoomSnapshot` | `{ roomId, snapshot: OnlineRoomSnapshot }` | Each **100 ms** tick while `playing`. Payload is **wrapped**: use **`data.snapshot`** (not `data` alone). **`snapshot.state`** holds authoritative sim state (snakes, coinbases, scores, etc.); **`snapshot.hud`** holds derived/display-friendly values (bars, labels). **Wire pruning:** live ticks omit duplicate **`currentCapture*`** (use **`hud.capture*`**), slim **`meta`** to **`modeLabel`**, and cap **`pointChanges`**; clients should **normalize** before render (see `chain-duel-react` `normalizeOnlineRoomSnapshot`). **Also** emitted ad hoc when mempool.space reports a **new tip block** (server spawns bonus food + pushes this snapshot). |
| `onlineBitcoinBlock` | `{ roomId, blockHeight, medianFeeSatPerVb }` | After a new block (same moment as extra food in sim). **Cosmetic** on client (SFX / flash); **authoritative food** is already in the accompanying or next **`onlineRoomSnapshot`**. |
| `resOnlineReplay` | compact-v2 + optional **`blockEvents`** | **`blockEvents`**: `{ frameIndex, blockHeight, medianFeeSatPerVb }[]` — when **`replayIndex`** hits **`frameIndex`**, clients should replay block SFX/flash (same as live `onlineBitcoinBlock`). Omitted on older archives. |
| `onlineSeatAssigned` | `{ roomId, playerRole, sessionId }` | After successful zap + seat assignment |
| `onlinePinInvalid` | `{ reason: string }` | Many failures (see table below) |
| `resOnlineNostrLinkChallenge` | `{ roomId, challenge, expiresAt }` | After `requestOnlineNostrLinkChallenge`; client signs **`kind: 1`**, **`content` = challenge** |
| `resOnlineNostrLinkOk` | `{ expiresAt: number }` | Pubkey linked to session until consumed or TTL |
| `resOnlinePostGameInfo` | See `socket.ts` | Successful `getOnlinePostGame` |
| `resCreateOnlineWithdrawal` | `{ roomId, lnurlw: string }` | `lnurlw` may be `'pass'` if zero amount |
| `resCreateOnlineNostrPayout` | `{ roomId, lnAddress, amount, ok: boolean }` | Successful zap payout |
| `onlineDoubleOrNothingUpdate` | `{ roomId, votes, required: 2, agreed }` | After a valid vote |

---

## Join PIN & Nostr zap (seat claim)

### Issuance

- `joinPin` is issued on `createOnlineRoom` / `joinOnlineRoom` / `joinOnlineRoomByCode` (not on spectate).
- PIN is **4 digits**, TTL **2 minutes**, unless extended while still valid and user remains eligible (`shouldPinStayActive` in state).
- One PIN is **consumed** on first successful zap that matches it for that `roomId`.

### Nostr pubkey link (no PIN in zap comment)

- **When:** Online lobby — link a **Nostr pubkey** to the browser **`sessionID`** so the Kind1 zap can be sent **without** putting the PIN in the comment; the server matches **`payerPubkey`** on the zap receipt to the pre-linked record.
- **App session shortcut:** If the user already completed **app sign-in** in Config (`confirmAppNostrLink`), `requestOnlineNostrLinkChallenge` may return **`resOnlineNostrLinkOk`** without a second kind-1 signature when the pubkey matches.
- **Socket flow:** `requestOnlineNostrLinkChallenge` `{ roomId }` → `resOnlineNostrLinkChallenge` `{ roomId, challenge, expiresAt }` (or auto **`resOnlineNostrLinkOk`**) → client signs **`kind: 1`** with **`content` exactly the `challenge`** when needed → `confirmOnlineNostrLink` `{ roomId, event }` → `resOnlineNostrLinkOk` `{ expiresAt }` or `onlinePinInvalid`.
- **Client signing:** **`chain-duel-react`** supports **NIP-07** (`window.nostr`) or **NIP-46** bunker / Nostr Connect (`nostr-tools` `BunkerSigner` + `parseBunkerInput` on a `bunker://…` URI or NIP-05). Same server verification either way.
- **Server:** Verifies the event with **`nostr-tools` `verifyEvent`**, then stores **`roomId:pubkey` → `{ sessionID, socketID }`** until consumed or TTL (**~15 min**).
- **Zap routing (`subscribeEvent.ts`, ONLINE):** If the zap comment yields a **PIN** (4-digit rule below), the **PIN path runs first**. Otherwise, if the zapper has a **`pubkey`**, the server tries **`consumeNostrLinkForZap`**. If that fails, the client sees `onlinePinInvalid` (e.g. `nostr_link_not_found`, `pin_missing` when anon and no link).
- **Arcades / shared screens:** Prefer the **PIN** path; no extension required.

### Zap comment parsing (`extractPinFromComment`)

- If the zap **content** (after trim) is exactly **4 digits**, that is the PIN.
- Otherwise the **first 4-digit substring** in the content is used.

**Recommended for agents:** send **only** the PIN (exactly four digits, no extra text). That avoids ambiguity if the server’s regex picks the wrong substring when multiple digit groups exist.

### Amount

- Must be **≥** Kind1 minimum (`nostrMeta.min` / published Kind1), or the server rejects with `amount_too_low`.

### Server routing

- Zap is matched to a room via `getRoomBySession(sessionID)` **or** `getRoomByKind1EventId`, where `sessionID` comes from the **Kind1 publisher** mapping (`getSessionIDfromKind1ID`), not from the zapper.

### Important quirk for agents

For several zap failures, `subscribeEvent.ts` emits `onlinePinInvalid` to `getSocketFromID(sessionID)` — the **Kind1 host session’s** current socket — **not** the zapper’s socket. Always reconcile state from **`onlineRoomUpdated` / `onlineRoomList`** as well, and do not assume error events arrive on the payer’s connection.

---

## `onlinePinInvalid.reason` catalog

| Reason | Typical source |
|--------|----------------|
| `room_not_found` | Bad `roomId` / code |
| `room_has_paid_seats` | `cancelOnlineRoom` blocked |
| `seats_not_filled` | `startOnlineGame` when second seat not paid |
| `postgame_unavailable` | `getOnlinePostGame` |
| `replay_unavailable` | `getOnlineReplay` |
| `only_winner_can_withdraw` | Withdraw / nostr payout |
| `rematch_pending` | Payout blocked while rematch flow active |
| `withdraw_started` | Payout already chosen / in progress |
| `lnurlw_create_failed` | LNbits failure |
| `winner_ln_missing` | Nostr payout without winner LN address |
| `zero_amount` | Nostr payout with zero computed amount |
| `nostr_payout_failed` | Pay invoice path threw |
| **Ready / lobby** | From `setSeatReady`: `room_not_ready`, `postgame_settled`, `not_paid_player` |
| **Zap / PIN** | `amount_too_low`, `pin_missing`, `not_found`, `room_mismatch`, `already_used`, `expired` |
| **Zap / Nostr link** | `nostr_link_not_found`, `nostr_link_expired`, `pubkey_already_linked`, `pubkey_already_seated`, `nostr_challenge_denied`, `nostr_challenge_mismatch`, `nostr_invalid_signature`, `nostr_invalid_kind`, `nostr_invalid_event`, `nostr_link_not_allowed` |
| **Seat assignment** | `room_not_found`, `rematch_locked`, `seats_full` |
| **Double-or-nothing / rematch zap** | `room_not_finished`, `withdraw_started`, `rematch_pending`, `not_player`, rematch: `rematch_not_requested`, `amount_too_low`, `winner_unknown`, `seats_not_ready`, `not_loser`, `winner_cannot_match` |

---

## Match start conditions

**Admission (`maybeStartPaidMatch`):** when `phase === 'lobby'`, both seats `status === 'paid'`, both `sessionID`s set, and both in `room.members` → phase becomes **`playing`** (pregame arena).

**Countdown (`maybeStartOnlineCountdown`):** when `phase === 'playing'`, both paid seats have `startConfirmed === true` → `startOnlineCountdown` → after 3-2-1 ticks, `gameStarted === true`.

If one player **disconnects** between paying and admission, the match **won’t** enter `playing` until **both** are back in `members`. After admission, each player must **`onlineConfirmStart`** on the arena (Space/Enter).

---

## Input and simulation

See **[Game rules (authoritative ONLINE)](#game-rules-authoritative-online)** for what those inputs *do* (snake movement, collisions, scoring).

- **Authoritative** state is server-side (`OnlineAuthoritativeState` in `onlineEngine.ts`).
- Clients should **render from `onlineRoomSnapshot`**, not predict long-term.
- `roomInput` sets **held directions** for that `sessionID`; the sim reads them each tick (`up`/`down`/`left`/`right` booleans).

**Input loop rate:** The server ticks at **100 ms**. In practice, sending inputs every **~80–100 ms** works well. Sending **much faster** than the tick is wasteful; sending **slower** than ~100 ms can miss ticks and feel laggy.

---

## Ping

Ping is optional. A seat that never reports still plays a valid match. The HUD badge stays blank until `pingMs` is a number. The value does not change the 100 ms simulation.

**Report it** once the seat is `paid`, about every **2.5 s** (what the web client does):

1. `emit('pingLatency', ack)` and measure `Date.now()` around the ack.
2. `emit('reportOnlineRoomPing', { roomId, latencyMs })` with that delta.

The server accepts this only from the paid seat whose `sessionID` matches the socket, clamps `latencyMs` to 0–10000, stores `seat.pingMs`, and emits `onlineRoomUpdated`. Spectators and the other player read both seats from that event. A spectator’s report is ignored.

**Steer with your own RTT.** A snapshot is already one-way late when it arrives, and `roomInput` takes about the same time to reach the next tick. Lead time in cells is that delay divided by **100 ms**, plus up to one extra cell if the packet misses the tick boundary. Commit the turn that many cells sooner. Measure `pingLatency` on the bot for this. `seat.pingMs` is the same quantity, refreshed only when someone reports.

**Opponent `pingMs`** is how many ticks they need before a new direction can take effect. Their late turns are already in the snapshots.

---

## Disconnect behavior

`disconnect` handler calls `leaveRoom(sessionID)` **without** `releaseSeat: true`.

- **Paid** seats: seat kept; `socketID` cleared/`disconnectedAt` set; `roomIdBySession` kept so reconnect can remap.
- **Unpaid** / spectator: membership and unpaid seat bindings cleared.

Explicit **`leaveOnlineRoom`** passes `releaseSeat: true` and **frees** paid seats back to `open`.

---

## Post-game payouts

- **Withdraw:** `createOnlineWithdrawal` — winner only (`winnerSessionID` or winner’s `socketID`). Computes `floor(winnerPoints * 0.95)` sats, creates LNURLw (unless zero → `pass`).
- **Nostr payout:** `createOnlineNostrPayout` — requires stored `winnerLnAddress`, pays LN address via LNURL flow on server.

Both block if `rematchRequested` or payout already started (`lnurlw` or `payoutMethod === 'nostr_zap'`).

---

## Double-or-nothing & rematch

1. Each player sends `onlineDoubleOrNothing` while `phase === 'finished'` and no payout started.
2. When **both** sessions voted, `agreed: true` → server publishes rematch Kind1 (`publishOnlineRematchKind1`) and sets `rematchRequested`, amounts, waiting session, etc.
3. **Loser** zaps the **rematch** event (tagged `e` = `rematchEventId`) with ≥ `rematchRequiredAmount`; pubkey must match loser seat if seat has `pubkey`.
4. On success, room resets toward a new lobby round (`resetRoomToLobby`).

---

## Battle-tested notes

These come from end-to-end agent runs (including Python bots). Use them to avoid common integration bugs.

**Items 1–2 elsewhere:** **NWC + NIP-57 seat payment** is documented under [Autonomy vs external systems](./AGENTS.md#autonomy-vs-external-systems) in **`AGENTS.md`**. **Where to find `kind1EventId` / `nostrMeta`** is in the [Happy path](#happy-path-two-players--optional-spectators) steps 5–6.

### 3. Seat purchase is asynchronous

After you pay the zap, the server processes it **asynchronously** before emitting **`onlineSeatAssigned`**. Wait for a paid seat on **`onlineRoomUpdated`** before assuming you are seated. When both seats are paid, the room enters **`playing`** automatically — then use **`onlineConfirmStart`** on the arena.

### 4. Double-payment prevention on reconnect

**`resJoinOnlineRoom`** (and `getOnlineRoomState` / `onlineRoomUpdated`) includes **`room.seats`**. Before paying again, check whether your **`sessionID`** already appears in a seat with **`status === 'paid'`**. If yes, **skip** the zap entirely.

```text
pseudo:
  seats = room.seats  // map or entries as per your type
  if any seat has seat.sessionID === mySessionId && seat.status === 'paid':
    // already paid; do not zap again
```

### 5. Input loop rate (~80–100 ms)

See [Input and simulation](#input-and-simulation): align with the **100 ms** server tick; **~90 ms** is a practical default.

### 6. `onlineRoomUpdated` fires often — debounce UI actions

During lobby, **`onlineRoomUpdated`** emits on membership / seat changes. Debounce local UI that reacts to every update.

### 7. `onlineRoomSnapshot` wrapping

Handlers receive **`{ roomId, snapshot }`**. Read **`snapshot.state`** for authoritative sim data and **`snapshot.hud`** for derived HUD fields — not the outer payload alone.

### 8. PIN format

The server extracts the PIN as the **first 4-digit substring** in zap content. **Safest:** send **only** the four digits (see [Zap comment parsing](#join-pin--nostr-zap-seat-claim) above).

### 9. Admission requires both players in `members`

`maybeStartPaidMatch` needs both seats paid and **both** `sessionID`s in **`room.members`**. A disconnect after pay but before admission blocks the arena until both reconnect.

### 10. Post-game flow is sequential

After **`phase === 'finished'`**, recommended order:

1. Emit **`getOnlinePostGame`** `{ roomId }`.
2. Wait for **`resOnlinePostGameInfo`**.
3. Emit **`createOnlineWithdrawal`** `{ roomId }` **or** **`createOnlineNostrPayout`** `{ roomId }` as appropriate.
4. Wait for **`resCreateOnlineWithdrawal`** (or Nostr response) — **`lnurlw`** may be the string **`'pass'`** when the computed **withdrawal amount is zero** (e.g. you lost); handle that case before attempting to redeem.
5. Redeem the LNURL-withdraw if you received a real LNURL.

---

## Agent implementation tips

1. **State:** Treat `onlineRoomUpdated` as the lobby/postgame source of truth; use `onlineRoomSnapshot` only for high-frequency game frames.
2. **Idempotency:** Re-sending `roomInput` with the same held keys is normal; releasing keys matters.
3. **Room list:** Subscribe to `resListOnlineRooms` if you need global lobby UI (server uses `io.emit` on changes).
4. **Testing:** Log `reason` on every `onlinePinInvalid`; cross-reference the table above.
5. **See also:** [Battle-tested notes](#battle-tested-notes) for NWC-oriented flows, ready timing, snapshot shape, and post-game ordering.
6. **Ping:** Report RTT so the badge shows, and use your own measurement as `roomInput` lead time. See [Ping](#ping).

---

## File map

| Concern | File |
|---------|------|
| Handlers | `marspayTS/src/socket/onlineRoom.ts` |
| State machine | `marspayTS/src/state/onlineRoomState.ts` |
| Tick loop | `startOnlineLoop` in `onlineRoom.ts` |
| Zap → seat | `marspayTS/src/calls/NDK/subscribeEvent.ts` (`GameMode.ONLINE` branch) |
| Socket registration | `marspayTS/src/socket/index.ts` |

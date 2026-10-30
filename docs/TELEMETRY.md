# Telemetry

Structured funnel and ops tracking for marspay. Events emit as JSON lines to stdout (`"type":"track"`), persist to `data/telemetry/events.jsonl`, and roll up into counters and the admin dashboard.

## Admin dashboard

After `npm run build`, open:

```
http://localhost:3001/dashboard
```

Sign in with `ADMIN_PASSWORD` from `.env` (httpOnly cookie session; no password in URL).

### API endpoints (cookie auth)

| Route | Purpose |
|-------|---------|
| `POST /dashboard/api/login` | `{ "password": "…" }` → session cookie |
| `POST /dashboard/api/logout` | Clear session |
| `GET /dashboard/api/me` | `{ authenticated: boolean }` |
| `GET /dashboard/api/overview` | KPI cards (legacy; Home tab preferred) |
| `GET /dashboard/api/home?window=24h\|7d` | Weekly review: activation, OMTM per mode, alerts, acquisition |
| `GET /dashboard/api/alerts?window=24h\|7d` | Threshold alerts |
| `GET /dashboard/api/money` | Bounty, deposits, payouts |
| `GET /dashboard/api/funnels/:mode?window=24h\|7d` | Step-conversion funnel (`quickmatch`, `challenge`, `p2p`, `online`, `nostr`) |
| `GET /dashboard/api/cohorts?window=7d\|24h` | Nostr player cohorts (Tier B) |
| `GET /dashboard/api/funnels` | Challenge, ONLINE, client funnel breakdowns |
| `GET /dashboard/api/challenges` | Win/replay stats, claims, bounty budget |
| `GET /dashboard/api/online` | Live rooms + match history |
| `GET /dashboard/api/activity?limit=100&event=challenge.&outcome=ok&since=24h&sessionID=…&pubkeyPrefix=…&roomCode=…` | Recent track events |
| `GET /dashboard/api/live` | Connected sessions with Nostr identity + context |
| `GET /dashboard/api/live/recent?hours=24` | 24h attempt rollup by pubkey/session |
| `GET /dashboard/api/live/:sessionID` | Session detail + last 20 events |
| `GET /dashboard/api/sessions` | Alias for `/live` (backward compatible) |
| `GET /dashboard/api/funnels?window=lifetime\|24h\|7d` | Funnel breakdowns |
| `GET /dashboard/api/visitors?hours=24` | Traffic + referrer/platform rollups |
| `GET /dashboard/api/quickmatch` | Quick Match stats |
| `GET /dashboard/api/p2p` | P2P funnel stats |
| `GET /dashboard/api/replays` | Replay/spectate stats |
| `GET /dashboard/api/journey?sessionID=…` or `?pubkey=…` | User timeline (Tier B) |
| `GET /dashboard/api/debug/raw` | Legacy full in-memory dump. Off unless `DASHBOARD_DEBUG_RAW=true`. |

### Local dev

```bash
# Terminal 1 — backend
npm run dev

# Terminal 2 — admin UI (proxies /dashboard/api to :3001)
cd admin && npm run dev
```

Or build and serve from marspay:

```bash
npm run build && npm start
```

### Verify after deploy

```bash
# Login and overview
curl -c /tmp/dash.cookie -X POST http://127.0.0.1:3001/dashboard/api/login \
  -H 'Content-Type: application/json' -d '{"password":"YOUR_ADMIN_PASSWORD"}'
curl -b /tmp/dash.cookie http://127.0.0.1:3001/dashboard/api/overview | jq .

# Track events in logs and on disk
grep '"type":"track"' logs/marspay-out.log | tail -5 | jq .
tail -3 data/telemetry/events.jsonl | jq .

# Or use the verification script
./scripts/verify-dashboard.sh
```

**Security:** Restrict `/dashboard` to localhost or VPN in nginx. Do not expose publicly without TLS and a strong `ADMIN_PASSWORD`.

## Event catalog

### Challenge bounty

| Event | When |
|-------|------|
| `challenge.eligibility` | After eligibility check |
| `challenge.run` | Challenge run requested |
| `challenge.win.submit` | Win submission received |
| `challenge.win.replay` | Replay validation result |
| `challenge.win.token` | Claim token issued |
| `challenge.claim` | Bounty claim attempt |
| `challenge.zap.retry` | Zap retry |

Human tags: `[CHALLENGE_START]`, `[CHALLENGE_ELIGIBILITY]`, plus existing `[CHALLENGE_WIN]` / `[CHALLENGE_CLAIM]`.

### Session and Nostr

| Event | When |
|-------|------|
| `session.connected` | Socket session accepted |
| `session.disconnected` | Socket disconnect |
| `nostr.app.link` | App Nostr session linked |

Human tags: `[SESSION_CONNECT]`, `[SESSION_DISCONNECT]`, `[NOSTR_SIGNIN]`.

### ONLINE

| Event | When |
|-------|------|
| `online.room.created` | Room created |
| `online.room.joined` | Join by room id |
| `online.room.joined_code` | Join by code |
| `online.room.spectate` | Spectator joined |
| `online.room.cancelled` | Host cancelled room |
| `online.seat.lightning.requested` | Seat Lightning invoice requested |
| `online.seat.ready` | Ready toggled |
| `online.game.started` | Match started |
| `online.game.finished` | Match archived |
| `online.payout.withdrawal` | LNURL-w payout |
| `online.payout.nostr` | Nostr zap payout |
| `online.rematch.vote` | Double-or-nothing vote |
| `online.seat.paid` | Seat payment confirmed |
| `online.seat.pay_rejected` | Seat payment rejected |
| `online.nostr.link` | Per-room Nostr seat link (kind-1 challenge) |
| `online.ping.reported` | Aggregated latency sample |

### Payments (P2P / practice / tournament)

| Event | When |
|-------|------|
| `deposit.paid` | LNURL-pay webhook (non-ONLINE seat) |
| `p2p.game.finished` | P2P/tournament game finished (server, `game.ts`) |

### Client beacons (`source: client`)

| Event | When |
|-------|------|
| `client.page.view` | Route change |
| `client.funnel.abandon` | Lobby left without pay/ready |
| `client.ui.error` | Surfaced UI error (`outcome: error`, `reason` from detail) |
| `client.session.context` | Once per tab session: referrer hostname, platform |
| `client.menu.selected` | Main menu navigation (`mode` in meta) |
| `client.practice.tab` | Practice hub tab switch (`free` / `challenges`) |
| `client.quickmatch.configured` | Quick Match config before start |
| `client.quickmatch.started` | Quick Match started |
| `client.quickmatch.completed` | Local practice match ended |
| `client.challenge.catalog_viewed` | Challenge list shown |
| `client.challenge.card_clicked` | Challenge card selected |
| `client.challenge.completed` | Challenge overlay shown (win/loss) |
| `client.p2p.configured` | P2P entry configured |
| `client.p2p.game_started` | Paid game started from menu |
| `client.p2p.game_completed` | Winner reached post-game |
| `client.p2p.withdrawal_created` | Withdrawal QR created |
| `client.p2p.double_or_nothing` | Double-or-nothing clicked |
| `client.online.replay_started` | Replay mode loaded |
| `client.online.replay_ended` | Replay session ended |
| `client.online.replay_speed_changed` | Replay speed changed |
| `client.online.spectate_started` | Spectator joined a room |

Client events are rate-limited (60/min per session). Events queue locally until the socket connects.

## Persistence

| File | Contents |
|------|----------|
| `data/telemetry/events.jsonl` | Append-only track event log (rotates at ~50MB) |
| `data/telemetry/challenge_stats.json` | Win/replay counters |
| `data/telemetry/counters.json` | Funnel counter rollup |
| `data/telemetry/traffic_daily.jsonl` | Daily unique sessions/visitors + country aggregates (7d retention) |
| `data/challenge_claims/claims.jsonl` | Paid bounty audit |
| `data/online_archive/index.jsonl` | ONLINE match index |

All under `data/` are gitignored.

## Privacy

Track events use `pubkeyPrefix` (12 hex chars) only. No nsec, NWC URIs, lud16, or replay payloads in `events.jsonl`.

### Dashboard identity policy

The admin dashboard (`/dashboard`, cookie auth) may show richer identity than the event log:

| Surface | What is shown |
|---------|----------------|
| **Player columns** (Live, Recent, Activity, Challenge/Money claims, ONLINE seats) | Avatar + display name linked to [njump.me](https://njump.me) when `npub` is known; nip05 handle as name fallback; **no npub/hex in table cells** |
| **Identity resolution** | `resolvePlayerIdentity` — live app session → profile cache by pubkey → prefix scan (`nostrProfileCache` + active `appNostrBySession`) → ONLINE seat name/picture → generic “Nostr player” / “Anonymous” |
| **Profile cache** | In-memory kind-0 metadata from Nostr sign-in, ONLINE seat pay, and relay reads (`nostrProfileCache.ts`). **Lost on server restart** until players re-sign-in or profiles are re-fetched |
| **Challenge claims** | Full pubkey resolved to identity via cache; admin API only |
| **Activity log** | `pubkeyPrefix` in raw event data; UI shows resolved `player` identity; CSV export includes `playerName` not npub |
| **Session drawer / Debug** | Technical IDs (sessionID, npub) in collapsible block only |
| **Anonymous / Lightning-only** | Labelled “Anonymous”; session ID stays in its own column |

### Tier B identity (no persistent visitorId)

- **sessionID** — per-tab visit timeline and Live tab
- **pubkeyPrefix** — cross-session journey for Nostr users (linked on `nostr.app.link`)
- **ipHash aggregates** — population-level visitor counts via `trafficAnalytics` (not per-user drill-down)
- **No** `localStorage` visitor UUID; User Explorer searches `sessionID` or `pubkey`/`npub` only

In-memory map `sessionIdentity.ts` links `pubkeyPrefix` → recent `sessionID`s for admin journey queries only.

**Not collected in event logs:** Raw IP addresses are not persisted in `events.jsonl` or funnel counters. App Nostr sessions expire after 24h (`APP_NOSTR_TTL_MS`).

### Traffic analytics (dashboard ops)

Server-side traffic metrics for capacity planning and abuse detection. Collected on socket connect only; **not** written to `events.jsonl`.

| Metric | Definition |
|--------|------------|
| `uniqueSessions24h` | Distinct `sessionID` with ≥1 connect in rolling 24h (reconnects do not double-count) |
| `uniqueVisitors24h` | Distinct daily salted IP hash in rolling 24h (approximate; NAT/shared IPs collapse) |
| `topCountries24h` | Distinct sessions and visitors per country code |
| `countrySeries7d` | Per UTC day, sessions per country from `traffic_daily.jsonl` |

**Collected (admin API only):** country code (`CF-IPCountry` when present), salted IP hash in memory for uniqueness, `sessionID` in rolling buffer.

**Not collected:** raw IP on disk, city-level geo, device fingerprint, referrer/UTM, cross-site tracking, joining traffic to Nostr pubkey.

**Retention:** rolling 24h connect buffer in memory (lost on server restart); daily country aggregates on disk for 7 days (`TRAFFIC_ROLLUP_RETENTION_DAYS`).

**Cloudflare / nginx:** pass `CF-IPCountry` to marspay so country is not `unknown`:

```nginx
proxy_set_header CF-IPCountry $http_cf_ipcountry;
proxy_set_header X-Real-IP $remote_addr;
```

Env: `TRAFFIC_SALT` (hash salt), `TRAFFIC_ROLLUP_RETENTION_DAYS` (default 7). See `.env.example`.

Restrict `/dashboard` to localhost or VPN. `ADMIN_PASSWORD` grants access to full pubkeys in API responses.

### Metric audit (overview KPIs)

| Field | Actual window | Notes |
|-------|---------------|-------|
| `challengeRunsTotal` | Lifetime | Funnel counter since deploy |
| `challengeRuns24h` | Rolling 24h | Scanned from `events.jsonl` tail (cap 10k lines) |
| `bountyPaidTodaySats` | Calendar day (UTC date key) | From `challenge_claims` daily spend |
| `connectedSessions` | Live | In-memory socket map |
| `activeOnlineRooms` | Live | Rooms not in `finished` phase |
| `traffic.uniqueSessions24h` | Rolling 24h | In-memory connect buffer (distinct sessionIDs) |
| `traffic.uniqueVisitors24h` | Rolling 24h | In-memory distinct salted IP hashes |
| `traffic.countrySeries7d` | 7 UTC days | `traffic_daily.jsonl` on disk |

Legacy field `challengeRunsToday` was removed (it was lifetime, not today).

## Dashboard product analytics

### Navigation (v2)

| Tab | Purpose |
|-----|---------|
| **Home** | North star + weekly review (default landing) |
| **Players** | Recent attempts, live sessions, Explorer, Nostr cohorts |
| **Modes** | Per-mode step-conversion funnels + depth stats |
| **Money** | Bounty cap, deposits, payouts |
| **Debug** | Activity log + advanced lifetime funnels |

Legacy `?tab=overview`, `live`, `explorer`, etc. redirect to the new tabs.

### North star and OMTM

| Scope | Metric | Definition |
|-------|--------|------------|
| **North star** | Activation rate | `sessionsWithGameActivity / uniqueSessions` (24h) — any quick match, challenge run, P2P deposit, or ONLINE seat |
| Quick Match | Start → complete % | `client.quickmatch.completed` / `client.quickmatch.started` |
| Challenges | Eligible → claim % | `challenge.claim` ok / `challenge.eligibility` ok |
| ONLINE | Seat paid → finished % | `online.game.finished` / `online.seat.paid` |
| P2P | Paid → finished % | `p2p.game.finished` / `deposit.paid` |

### Weekly review ritual (~2 min)

1. Open **Home** — activation down? Check mode OMTM cards and alerts.
2. Click the worst **drop-off** — opens **Modes** funnel for that mode.
3. Read **reject reasons** at the drop step.
4. **Players → Explorer** — inspect 1–2 journeys (from Activity session links).
5. Ship one product fix; compare same window next week.

### Tier B cohort limitations

Cohort views (`/dashboard/api/cohorts`) use `pubkeyPrefix` only. Anonymous visitors remain aggregate (IP hash). Do not treat cohort data as full user tracking.

### Scan limits

Rolling-window metrics scan the last 10,000 lines of `events.jsonl`. Low-traffic deploys are accurate; high traffic may under-count historical windows.

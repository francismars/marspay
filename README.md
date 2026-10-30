# MarsPay V2

**Reusable Lightning backend** for **1v1 games** and similar match formats. Plug in **your own frontend** — web, mobile, or bot — as long as it speaks the **Socket.IO** contract. The server handles **LNbits** LNURL pay and withdraw, **Nostr** zaps and Kind1 flows (via NDK), and **session + game state** so stakes, admissions, and payouts stay consistent.

**Chain Duel** is the reference game that ships alongside this repo; the same stack supports **other projects** that need paid lobbies, duels, tournaments, or ONLINE-style matches without rebuilding Lightning plumbing.

For the full feature guide across Chain Duel + marspay, see **[../chain-duel/docs/FEATURES.md](../chain-duel/docs/FEATURES.md)**.

## Architecture

```
chain-duel-react (frontend)  ←→  marspay (this repo)  ←→  LNbits / Nostr relays
```

- **Frontend:** `chain-duel/chain-duel-react/` — React + PixiJS client
- **Backend:** this repo — Socket.IO + Express on port 3001 (default)
- **Shared types:** `chain-duel/chain-duel-react/src/types/socket.ts` (must stay in sync with handlers here)

## Features

### Sessions & identity

- Stable emoji-prefixed `sessionID` per client (`emoji:11-char-nanoid`)
- Reconnect with persisted ID restores seat ownership, LNURL state, and game mappings
- 2-hour inactivity cleanup; completed games appended to `public/games.json`

### Game modes

| Mode | Description | Min buy-in |
|------|-------------|------------|
| **P2P** | Classic 1v1; two LNURL-pay links | 3,000 sats |
| **P2PNOSTR** | 1v1 via Nostr Kind1 + zap admissions | Zap amount |
| **PRACTICE** | Single-player vs AI | 150 sats |
| **TOURNAMENT** | Bracket (4/8/16/32 players); one LNURL-pay | Configurable |
| **TOURNAMENTNOSTR** | Tournament via Nostr Kind1 + zaps | Configurable |
| **ONLINE** | Server-authoritative 2P rooms with lobby, spectators, replay | 1,000 sats |

P2P and tournament games run **locally in the browser**; the server coordinates payments and results. **ONLINE** runs the full simulation server-side at 100 ms/tick.

### Lightning

- **LNURL-pay (deposits)** — per-player buy-in links via LNbits
- **LNURL-withdraw (payouts)** — winner withdrawal links (95% payout multiplier)
- **Payment webhooks** — `POST /api/LNURL/paid`, `POST /api/LNURL/withdrawn`
- **Revenue splits** — host / developer / designer percentages on non-ONLINE deposits
- **Invoice payment** — server pays invoices (bounty zaps, splits)
- **Lightning address resolution** — LNURL callback + invoice for LUD16 addresses

### Nostr

- **NDK relay client** — publish/subscribe on configured relays
- **Kind1 game notes** — lobby notes for P2P, tournament, and ONLINE rooms
- **Zap subscription (NIP-57)** — seat assignment and P2P/tournament payments
- **End-game Kind1** — victory notes for Nostr modes
- **Zap payout** — pay winners via LNURL-pay to LUD16
- **App Nostr session** — challenge-response link between browser signer and socket session
- **Profile / eligibility** — Kind0, NIP-05, follow counts, account age checks

### ONLINE mode (authoritative multiplayer)

The largest feature area. Full protocol: [docs/AGENTS_ONLINE.md](docs/AGENTS_ONLINE.md).

- Room lifecycle: `lobby` → `playing` → `postgame` → `finished`
- Create/join by room code; 4-digit PIN for seat zaps (2 min TTL)
- Three seat purchase paths: Lightning invoice, Nostr web zap, PIN-in-comment zap
- Nostr pubkey linking for PIN-less zaps
- Server simulation: 51×25 grid, snakes, coinbases, zero-sum scoring
- Mempool.space block bonus coinbase spawns
- Post-game: LNURL-withdraw or Nostr zap payout; double-or-nothing rematch
- Compact gzip replay archive (up to 3,600 frames); match history and Hall of Fame
- Spectator support

### Challenge bounty (practice)

Server-validated practice challenges with real Lightning bounties. Full protocol: [docs/AGENTS_CHALLENGE_BOUNTY.md](docs/AGENTS_CHALLENGE_BOUNTY.md).

| Challenge | Format | Bounty (sats) |
|-----------|--------|---------------|
| NORMIE DUEL | 1v1 | 21 |
| STACKER TRIAL | 1v1 | 210 |
| NODE RUNNER | 1v1 + powerups | 420 |
| SOVEREIGN GAUNTLET | 1v1 | 1337 |
| FFA RUMBLE | 4P FFA | 2100 |
| SOVEREIGN STACK | 1v1 + powerups | 4200 |

- Eligibility: NIP-05, 100+ follows, follow @chainduel, 30-day account age, LUD16, app session
- Seeded replay validation (shared RNG with client)
- Victory Kind1 publish + NIP-57 zap; daily spend cap and rate limits

### Admin & ops

- `GET /dashboard` — React ops dashboard (sign in with `ADMIN_PASSWORD`)
- `GET /dashboard/api/*` — structured telemetry API (see [docs/TELEMETRY.md](docs/TELEMETRY.md))
- `GET /dashboard/api/debug/raw` — legacy full in-memory JSON dump, only when `DASHBOARD_DEBUG_RAW=true`
- Static assets at `GET /public/*`

Build includes the admin UI: `npm run build` (runs `tsc` + `build:admin`).

## Tech stack

- **Node.js**, **TypeScript**, **Express** (HTTP)
- **Socket.IO** (WebSocket)
- **@nostr-dev-kit/ndk** (Nostr)
- **LNbits** hooks for LNURL

## Repository layout

```
src/
  server.ts          # HTTP server + Socket.IO bootstrap
  app.ts             # Express routes (LNURL webhooks, static, dashboard)
  socket/            # All Socket.IO event handlers
  routes/            # LNURL paid / withdrawn HTTP handlers
  calls/             # LNbits API, LN address, NDK publish/subscribe
  state/             # Session, game, ONLINE room, Nostr, challenge state
  game/              # ONLINE authoritative sim + challenge engine
```

## Setup

```bash
git clone https://github.com/francismars/marspayV2.git
cd marspayV2
npm install
npm run dev
```

- **Dev:** `npm run dev` — **http://localhost:3001** (override with `PORT` in `.env`)
- **Production:** see Deployment section below.

## Deployment (production)

The server runs under **PM2** using the `ecosystem.config.js` at the project root. PM2 handles auto-restart on crash and restart on system reboot.

### First-time setup

```bash
npm install
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # run the command it prints to enable reboot persistence
```

### Deploy after a code change

```bash
git pull && npm install && npm run build && pm2 restart marspay
```

> `npm install` (not `--omit=dev`) is required before build because `@types/*` packages live in devDependencies and are needed by the TypeScript compiler.

### Logs

```bash
pm2 logs marspay             # live tail
pm2 logs marspay --lines 100 # last 100 lines
```

Log files are written to `logs/` in the project root (gitignored).

## Environment

Copy [`.env.example`](.env.example) to `.env` and fill in values from your LNbits deployment:

```bash
cp .env.example .env
```

Key variables: `PORT`, `LNBITS_*`, `LNBITS_WEBHOOK_SECRET`, `NOSTR_PK`, `HOST_LNADDRESS`, `DEVELOPER_LNADDRESS`, `DESIGNER_LNADDRESS`, `ADMIN_PASSWORD`, `CHAINDUEL_NOSTR_PUBKEY`, `CHALLENGE_BOUNTY_DAILY_CAP_SATS`.

`LNBITS_WEBHOOK_SECRET` replaces the old `LNBITS_IP` allowlist. Deposit and withdraw webhooks accept only a request whose `X-Webhook-Secret` header matches it. Set the secret before restarting, and recreate any LNURL link that was created without it. A wrong secret blocks real deposits and withdrawals.

## API and documentation

| Document | Contents |
|----------|----------|
| [docs/AGENTS.md](docs/AGENTS.md) | Sessions, reconnect, bot integration, game rules summary |
| [docs/AGENTS_ONLINE.md](docs/AGENTS_ONLINE.md) | Full ONLINE protocol — lobby, zaps, PIN, snapshots, payouts, replay |
| [docs/AGENTS_NOSTR_SESSION.md](docs/AGENTS_NOSTR_SESSION.md) | App-level Nostr sign-in vs room link |
| [docs/AGENTS_CHALLENGE_BOUNTY.md](docs/AGENTS_CHALLENGE_BOUNTY.md) | Challenge bounty protocol, eligibility, persistence |
| [../chain-duel/docs/FEATURES.md](../chain-duel/docs/FEATURES.md) | Full feature guide (frontend + backend) |
| `chain-duel-react/src/types/socket.ts` | TypeScript socket event mirror |

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Development server with reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server |
| `npm run lint` | ESLint on `src/` |

## License

MIT

## Contributing

Issues and pull requests are welcome.

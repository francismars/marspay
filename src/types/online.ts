import { PlayerRole } from './game';
import { OnlineAuthoritativeState, OnlineHudState } from '../game/onlineEngine';
import type { OnlineSessionInput } from '../game/onlineInput';

/** `postgame` = match sim ended (DoN / rematch / payout). `finished` = winner closed round (payout chosen). */
export type OnlineRoomPhase = 'lobby' | 'playing' | 'postgame' | 'finished' | 'cancelled';

export interface OnlineRoomNostrMeta {
  note1: string;
  min: number;
  mode: string;
}

export interface OnlineSeatState {
  role: PlayerRole.Player1 | PlayerRole.Player2;
  sessionID?: string;
  socketID?: string;
  status: 'open' | 'paid';
  paidAmount?: number;
  paidAt?: number;
  ready?: boolean;
  /** Set while this paid seat's socket is gone. Cleared on reconnect. */
  disconnectedAt?: number;
  /** Ms already spent disconnected this match. The open disconnect is added on top. */
  disconnectMs?: number;
  name?: string;
  picture?: string;
  pubkey?: string;
  lnAddress?: string;
  /** How this seat was paid: lightning invoice, web sign-in zap, or external app + PIN. */
  payMethod?: 'lightning' | 'nostr_web' | 'nostr_app';
  /** Arena pre-start: player pressed confirm on canvas. */
  startConfirmed?: boolean;
  /** Last RTT (ms) reported by that seat's client; broadcast via `onlineRoomUpdated`. */
  pingMs?: number;
}

export interface OnlineRoomSnapshot {
  tick: number;
  phase: OnlineRoomPhase;
  state: OnlineAuthoritativeState;
  hud: OnlineHudState;
}

/** Stored in compact replay; drives block SFX/flash during replay playback. */
export interface OnlineReplayBlockEvent {
  /** Replay frame index when that step’s snapshot first includes the mempool-spawned coinbase. */
  frameIndex: number;
  blockHeight: number;
  medianFeeSatPerVb: number;
}

export interface OnlineRoomMember {
  sessionID: string;
  socketID: string;
  joinedAt: number;
  lastSeen: number;
}

export interface OnlineRoom {
  roomId: string;
  roomCode: string;
  hostSessionID: string;
  hostSocketID: string;
  createdAt: number;
  updatedAt: number;
  /** Last join, input, payment, or other real activity. Sim ticks do not move this. */
  lastActivityAt: number;
  buyin: number;
  /** Incremented each time lobby → playing (match 1, 2, … for DoN rematches). */
  matchRound: number;
  kind1EventId?: string;
  /** Latest Kind1 in the room Nostr thread; next reply parents this (linear chain). */
  nostrThreadTipEventId?: string;
  /** `matchRound` for which the "match started" thread reply was already published. */
  nostrMatchStartedPostedRound?: number;
  phase: OnlineRoomPhase;
  nostrMeta?: OnlineRoomNostrMeta;
  members: Map<string, OnlineRoomMember>;
  spectators: Set<string>;
  seats: Map<PlayerRole.Player1 | PlayerRole.Player2, OnlineSeatState>;
  inputBySession: Map<string, OnlineSessionInput>;
  snapshot: OnlineRoomSnapshot;
  replay: {
    tickMs: number;
    frames: OnlineRoomSnapshot[];
    recordedAt?: number;
    blockEvents?: OnlineReplayBlockEvent[];
  };
  postGame: {
    p1Picture?: string;
    p2Picture?: string;
    winnerRole?: PlayerRole.Player1 | PlayerRole.Player2;
    winnerSessionID?: string;
    winnerName: string;
    winnerPicture?: string;
    winnerPoints: number;
    totalPrize: number;
    lnurlw?: string;
    payoutMethod?: 'withdraw_qr' | 'nostr_zap';
    payoutTarget?: string;
    rematchRequested?: boolean;
    rematchRequiredAmount?: number;
    rematchEventId?: string;
    rematchNote1?: string;
    rematchWaitingForSessionID?: string;
    settledAt?: number;
    doubleOrNothingVotes: Set<string>;
    /** `abandoned` keeps the pot in the house and must not open a winner withdrawal. */
    outcome?: 'forfeit' | 'abandoned';
    /** Ms the winner has already been disconnected during postgame. Match disconnect time is not included. */
    claimBankMs?: number;
    /** A claim-expiry payout is in flight or waiting out a retry. */
    claimPayoutPending?: boolean;
    claimPayoutAttemptAt?: number;
  };
}

/** Shown while a paid seat is disconnected. Remaining time accumulates across reconnects. */
export interface OnlineForfeitPause {
  paused: boolean;
  limitMs: number;
  p1RemainingMs?: number;
  p2RemainingMs?: number;
}

/** Winner must claim before this runs out. Only present during postgame while that seat is disconnected. */
export interface OnlineClaimClock {
  remainingMs: number;
  limitMs: number;
}

/** One completed sim in a room (match 1, 2, … for double-or-nothing sessions). */
export interface OnlineMatchRoundSummary {
  matchRound: number;
  finishedAt: number;
  winnerName: string;
  p1Name: string;
  p2Name: string;
  p1Score: number;
  p2Score: number;
  netPrize: number;
  winnerRole?: PlayerRole.Player1 | PlayerRole.Player2;
  /** False when the match archive has no recorded frames (e.g. never started). */
  replayAvailable?: boolean;
}

export interface OnlineRoomListItem {
  roomId: string;
  roomCode: string;
  buyin: number;
  createdAt: number;
  /** Wall time when the match ended (settled or last update), for sorting history. */
  finishedAt?: number;
  phase: OnlineRoomPhase;
  playersPaid: number;
  seatsTotal: number;
  spectators: number;
  /** Double-or-nothing rematch in progress (phase may still be postgame). */
  rematchRequested?: boolean;
  /** True when loaded from `data/online_archive/` (not live memory). */
  archived?: boolean;
  /** Which match in a multi-game room (double-or-nothing); from per-match archive rows. */
  matchRound?: number;
  /** From archive index: `match` = one sim; `session` = room after winner closed payout. */
  archiveKind?: 'match' | 'session';
  result?: {
    winnerName: string;
    p1Name: string;
    p2Name: string;
    p1Score: number;
    p2Score: number;
    netPrize: number;
    p1Picture?: string;
    p2Picture?: string;
    winnerPicture?: string;
    winnerRole?: PlayerRole.Player1 | PlayerRole.Player2;
    /** Absent on a normal score finish. */
    outcome?: 'forfeit' | 'abandoned';
    p1Paid?: number;
    p2Paid?: number;
  };
  replay?: {
    available: boolean;
    frameCount: number;
    tickMs: number;
    durationMs: number;
  };
}

export interface JoinPinRecord {
  pin: string;
  roomId: string;
  sessionID: string;
  socketID: string;
  expiresAt: number;
  used: boolean;
  usedAt?: number;
}

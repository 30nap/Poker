/**
 * WebSocket wire protocol between the web client and the room server.
 * All messages are JSON. The game state sent to a client is ALWAYS the
 * engine's redacted view for that player — hidden information never
 * crosses the wire.
 */

import type { Action, GameState } from '@poker/engine';

/** Default milliseconds a player has to act before being checked/folded. */
export const DEFAULT_TURN_MS = 30_000;

/** Default pause between the end of a hand and the next deal. */
export const DEFAULT_INTER_HAND_MS = 5_000;

export const ROOM_CODE_LENGTH = 5;
export const MAX_PLAYERS_PER_ROOM = 6;
export const MAX_NAME_LENGTH = 16;
export const ONLINE_BUY_IN = 1000;

export interface LobbyPlayer {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  host: boolean;
}

export type ClientMsg =
  /** Create a new room; the creator becomes the host. */
  | { t: 'create'; name: string }
  /** Join a room by code. Include `token` to reclaim a seat after a disconnect. */
  | { t: 'join'; code: string; name?: string; token?: string }
  /** Toggle readiness while in the lobby. */
  | { t: 'ready'; ready: boolean }
  /** Host only: start the game once everyone is ready. */
  | { t: 'start' }
  /** Take a game action; the server validates against the engine. */
  | { t: 'action'; action: Action }
  /** Permanently give up the seat. */
  | { t: 'leave' }
  | { t: 'ping' };

export type ServerMsg =
  /** Seat granted. Store `token` to reconnect to the same seat. */
  | { t: 'joined'; code: string; you: string; token: string }
  | { t: 'lobby'; players: LobbyPlayer[]; started: boolean }
  /**
   * Authoritative game state, redacted for the receiving player.
   * `deadline` is the epoch-ms auto-action time for the current actor.
   */
  | {
      t: 'state';
      state: GameState;
      deadline: number | null;
      names: Record<string, string>;
      connected: Record<string, boolean>;
    }
  | { t: 'error'; code: ErrorCode; msg: string }
  | { t: 'pong' };

export type ErrorCode =
  | 'bad-message'
  | 'room-not-found'
  | 'room-full'
  | 'room-started'
  | 'not-in-room'
  | 'not-host'
  | 'not-ready'
  | 'bad-action';

export function sanitizeName(raw: string | undefined, fallback: string): string {
  const name = (raw ?? '').trim().slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : fallback;
}

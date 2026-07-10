/**
 * A poker room: seats, lobby readiness, and one engine game.
 *
 * The room is the only writer of its GameState. It feeds player actions and
 * timeouts into the pure engine and broadcasts each player's redacted view
 * after every transition. Transport concerns (timers, disconnects) live
 * here — never in the engine.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  applyAction,
  createGame,
  defaultAction,
  GameState,
  redactStateFor,
  startHand,
  type Action,
} from '@poker/engine';
import {
  DEFAULT_INTER_HAND_MS,
  DEFAULT_TURN_MS,
  MAX_PLAYERS_PER_ROOM,
  ONLINE_BUY_IN,
  type ErrorCode,
  type LobbyPlayer,
  type ServerMsg,
} from '@poker/shared';

const BLINDS = { smallBlind: 5, bigBlind: 10 };
/** Disconnected players act fast so the table doesn't wait the full clock. */
const DISCONNECTED_TURN_MS = 3_000;

export interface SeatConnection {
  send(msg: ServerMsg): void;
  close(): void;
}

export interface Seat {
  id: string;
  name: string;
  token: string;
  ready: boolean;
  connected: boolean;
  /** Gave up the seat for good (auto-fold forever, no reconnect). */
  left: boolean;
  conn: SeatConnection | null;
}

export interface RoomOptions {
  turnMs?: number;
  interHandMs?: number;
}

export class RoomError extends Error {
  constructor(
    public readonly code: ErrorCode,
    msg: string,
  ) {
    super(msg);
  }
}

export class Room {
  readonly seats: Seat[] = [];
  state: GameState | null = null;
  started = false;
  deadline: number | null = null;

  private readonly turnMs: number;
  private readonly interHandMs: number;
  private turnTimer: NodeJS.Timeout | null = null;
  private nextHandTimer: NodeJS.Timeout | null = null;
  /** Bumped whenever the acting context changes, to invalidate stale timers. */
  private turnEpoch = 0;

  constructor(
    readonly code: string,
    opts: RoomOptions = {},
  ) {
    this.turnMs = opts.turnMs ?? DEFAULT_TURN_MS;
    this.interHandMs = opts.interHandMs ?? DEFAULT_INTER_HAND_MS;
  }

  // ------------------------------------------------------------- seating

  join(name: string, conn: SeatConnection): Seat {
    if (this.started) throw new RoomError('room-started', 'game already started');
    if (this.activeSeats().length >= MAX_PLAYERS_PER_ROOM) {
      throw new RoomError('room-full', 'room is full');
    }
    const seat: Seat = {
      id: `p-${randomBytes(4).toString('hex')}`,
      name: this.dedupeName(name),
      token: randomUUID(),
      ready: false,
      connected: true,
      left: false,
      conn,
    };
    this.seats.push(seat);
    this.sendJoined(seat);
    this.broadcastLobby();
    return seat;
  }

  reconnect(token: string, conn: SeatConnection): Seat {
    const seat = this.seats.find((s) => s.token === token && !s.left);
    if (!seat) throw new RoomError('room-not-found', 'no seat for this session');
    seat.conn?.close();
    seat.conn = conn;
    seat.connected = true;
    this.sendJoined(seat);
    this.broadcastLobby();
    if (this.started) {
      this.broadcastState();
      this.rearmTurnTimer();
    }
    return seat;
  }

  disconnect(seat: Seat): void {
    if (seat.conn === null && !seat.connected) return;
    seat.conn = null;
    seat.connected = false;
    if (!this.started) {
      // Lobby: a dropped connection simply frees the seat.
      this.removeSeat(seat);
      this.broadcastLobby();
      return;
    }
    this.broadcastState();
    this.rearmTurnTimer();
  }

  leave(seat: Seat): void {
    seat.left = true;
    seat.ready = false;
    seat.conn = null;
    seat.connected = false;
    if (!this.started) {
      this.removeSeat(seat);
      this.broadcastLobby();
      return;
    }
    // Mid-game: fold their turn immediately if it is on them now.
    if (this.state && this.state.actor !== null && this.actorSeat()?.id === seat.id) {
      this.applyEngineAction(seat.id, defaultAction(this.state));
    } else {
      this.broadcastState();
    }
    this.broadcastLobby();
  }

  private removeSeat(seat: Seat): void {
    const i = this.seats.indexOf(seat);
    if (i !== -1) this.seats.splice(i, 1);
  }

  private dedupeName(name: string): string {
    let candidate = name;
    let n = 2;
    while (this.seats.some((s) => !s.left && s.name === candidate)) {
      candidate = `${name} ${n++}`;
    }
    return candidate;
  }

  /** Seats that still belong to someone (connected or eligible to reconnect). */
  activeSeats(): Seat[] {
    return this.seats.filter((s) => !s.left);
  }

  isAbandoned(): boolean {
    return this.activeSeats().every((s) => !s.connected);
  }

  // --------------------------------------------------------------- lobby

  setReady(seat: Seat, ready: boolean): void {
    if (this.started) throw new RoomError('room-started', 'game already started');
    seat.ready = ready;
    this.broadcastLobby();
  }

  start(seat: Seat): void {
    if (this.started) throw new RoomError('room-started', 'game already started');
    if (this.hostSeat()?.id !== seat.id) {
      throw new RoomError('not-host', 'only the host can start the game');
    }
    const players = this.activeSeats();
    if (players.length < 2) throw new RoomError('not-ready', 'need at least 2 players');
    if (!players.every((s) => s.ready)) {
      throw new RoomError('not-ready', 'all players must be ready');
    }

    this.started = true;
    this.state = startHand(
      createGame(
        players.map((s) => ({ id: s.id, stack: ONLINE_BUY_IN })),
        BLINDS,
        Math.floor(Math.random() * players.length),
      ),
    );
    this.broadcastLobby();
    this.afterTransition();
  }

  hostSeat(): Seat | undefined {
    return this.activeSeats()[0];
  }

  // -------------------------------------------------------------- actions

  handleAction(seat: Seat, action: Action): void {
    if (!this.started || !this.state) throw new RoomError('bad-action', 'game not started');
    const actor = this.actorSeat();
    if (!actor || actor.id !== seat.id) throw new RoomError('bad-action', 'not your turn');
    this.applyEngineAction(seat.id, action);
  }

  private applyEngineAction(playerId: string, action: Action): void {
    if (!this.state) return;
    try {
      this.state = applyAction(this.state, playerId, action);
    } catch (err) {
      throw new RoomError('bad-action', err instanceof Error ? err.message : 'illegal action');
    }
    this.afterTransition();
  }

  private actorSeat(): Seat | undefined {
    if (!this.state || this.state.actor === null) return undefined;
    const id = this.state.players[this.state.actor]!.id;
    return this.seats.find((s) => s.id === id);
  }

  // ------------------------------------------------------------ lifecycle

  /** After any engine transition: broadcast, arm timers, schedule next hand. */
  private afterTransition(): void {
    if (!this.state) return;

    if (this.state.phase === 'waiting') {
      this.deadline = null;
      this.clearTurnTimer();
      this.broadcastState();
      this.scheduleNextHand();
      return;
    }
    this.armTurnTimer();
    this.broadcastState();
  }

  private scheduleNextHand(): void {
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      if (!this.state || this.state.phase !== 'waiting') return;

      const next = structuredClone(this.state);
      // Virtual chips: busted players re-buy automatically between hands,
      // but only while someone is still there to play them.
      for (const p of next.players) {
        const seat = this.seats.find((s) => s.id === p.id);
        if (p.stack <= 0 && seat && !seat.left) {
          p.stack = ONLINE_BUY_IN;
          p.out = false;
        }
      }
      const playable = next.players.filter((p) => {
        const seat = this.seats.find((s) => s.id === p.id);
        return p.stack > 0 && seat && !seat.left;
      });
      if (playable.length < 2 || this.isAbandoned()) return;

      this.state = startHand(next);
      this.afterTransition();
    }, this.interHandMs);
  }

  private armTurnTimer(): void {
    this.clearTurnTimer();
    const actor = this.actorSeat();
    if (!this.state || this.state.actor === null || !actor) {
      this.deadline = null;
      return;
    }
    const ms = actor.connected ? this.turnMs : DISCONNECTED_TURN_MS;
    this.deadline = Date.now() + ms;
    const epoch = ++this.turnEpoch;
    this.turnTimer = setTimeout(() => {
      if (epoch !== this.turnEpoch || !this.state || this.state.actor === null) return;
      const current = this.actorSeat();
      if (!current) return;
      this.applyEngineAction(current.id, defaultAction(this.state));
    }, ms);
  }

  /** Re-arm without resetting the deadline logic (used on reconnect changes). */
  private rearmTurnTimer(): void {
    if (this.started && this.state && this.state.phase !== 'waiting') {
      this.armTurnTimer();
    }
  }

  private clearTurnTimer(): void {
    this.turnEpoch++;
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  destroy(): void {
    this.clearTurnTimer();
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    for (const seat of this.seats) seat.conn?.close();
  }

  // ------------------------------------------------------------ messaging

  private sendJoined(seat: Seat): void {
    seat.conn?.send({ t: 'joined', code: this.code, you: seat.id, token: seat.token });
  }

  broadcastLobby(): void {
    const host = this.hostSeat();
    const players: LobbyPlayer[] = this.activeSeats().map((s) => ({
      id: s.id,
      name: s.name,
      ready: s.ready,
      connected: s.connected,
      host: s.id === host?.id,
    }));
    this.broadcast({ t: 'lobby', players, started: this.started });
  }

  broadcastState(): void {
    if (!this.state) return;
    const names: Record<string, string> = {};
    const connected: Record<string, boolean> = {};
    for (const s of this.seats) {
      names[s.id] = s.name;
      connected[s.id] = s.connected;
    }
    for (const seat of this.seats) {
      if (!seat.conn) continue;
      seat.conn.send({
        t: 'state',
        state: redactStateFor(this.state, seat.id),
        deadline: this.deadline,
        names,
        connected,
      });
    }
  }

  private broadcast(msg: ServerMsg): void {
    for (const seat of this.seats) seat.conn?.send(msg);
  }
}

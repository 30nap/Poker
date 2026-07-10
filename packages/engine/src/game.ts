/**
 * Texas Hold'em no-limit game state machine.
 *
 * The engine is a set of pure functions over a plain, JSON-serializable
 * state object: `startHand` and `applyAction` return new states and never
 * mutate their input. There is no I/O, no timers and no randomness beyond
 * an injectable deck/RNG, so the same module runs unchanged in the browser
 * (offline mode) and on a server (online mode). Turn timeouts belong to the
 * transport layer, which can call `defaultAction` to act for a stalled
 * player.
 *
 * Conventions:
 * - Seats are fixed array indices; the button is a seat index.
 * - Hole cards are dealt two consecutive cards per player, in seat order
 *   starting left of the button (deterministic for injected test decks).
 * - Heads-up: the button posts the small blind, acts first pre-flop and
 *   last on every later street.
 * - `raise.to` is the total street-bet level being raised to (an opening
 *   bet is a raise from 0). An all-in below the minimum raise is allowed
 *   but does not reopen the action for players who already acted.
 */

import { Card, makeDeck, RNG, shuffle } from './cards.js';
import { evaluateHand } from './evaluator.js';
import { computePots } from './pots.js';

export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type Phase = 'waiting' | Street;

export interface GameConfig {
  smallBlind: number;
  bigBlind: number;
}

export interface PlayerState {
  id: string;
  stack: number;
  /** Busted out of the game; skipped when dealing. */
  out: boolean;
  folded: boolean;
  /** null when not dealt into the current hand. */
  hole: [Card, Card] | null;
  /** Chips committed during the current betting round. */
  streetBet: number;
  /** Chips committed during the whole hand. */
  totalBet: number;
  /** Has taken a voluntary action since the last full raise this round. */
  acted: boolean;
}

export interface PotResult {
  amount: number;
  eligible: string[];
  winners: string[];
  /** Chips awarded per winner (includes odd-chip distribution). */
  shares: Record<string, number>;
}

export interface HandResult {
  pots: PotResult[];
  /** false when the hand ended uncontested (everyone else folded). */
  showdown: boolean;
  /** Hole cards and hand strength of showdown participants; null if uncontested. */
  revealed: Record<string, { hole: [Card, Card]; value: number; name: string; best: Card[] }> | null;
}

export interface GameState {
  config: GameConfig;
  players: PlayerState[];
  button: number;
  phase: Phase;
  community: Card[];
  /** Undealt cards. Server must strip this before sending state to clients. */
  deck: Card[];
  /** Highest streetBet this round. */
  currentBet: number;
  /** Size of the last full bet/raise; sets the minimum re-raise. */
  lastRaiseSize: number;
  /** Seat index of the player to act, or null between hands. */
  actor: number | null;
  handNumber: number;
  /** Result of the most recently completed hand. */
  result: HandResult | null;
}

export type Action =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  /** Bet or raise TO this total street-bet level. */
  | { type: 'raise'; to: number };

export interface LegalActions {
  fold: boolean;
  check: boolean;
  /** Chips required to call (clamped to stack), or null if nothing to call. */
  callAmount: number | null;
  /** Raise-to bounds, or null if raising is not allowed. */
  raise: { minTo: number; maxTo: number } | null;
}

export interface StartHandOptions {
  /** Explicit deck for deterministic tests; dealt from index 0. */
  deck?: readonly Card[];
  /** RNG used to shuffle when no deck is given. */
  rng?: RNG;
}

// ---------------------------------------------------------------------------
// Setup

export function createGame(
  players: readonly { id: string; stack: number }[],
  config: GameConfig,
  button = 0,
): GameState {
  if (players.length < 2 || players.length > 10) {
    throw new Error('createGame requires 2-10 players');
  }
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) throw new Error('player ids must be unique');
  if (config.smallBlind <= 0 || config.bigBlind < config.smallBlind) {
    throw new Error('invalid blind configuration');
  }
  return {
    config: { ...config },
    players: players.map((p) => ({
      id: p.id,
      stack: p.stack,
      out: p.stack <= 0,
      folded: false,
      hole: null,
      streetBet: 0,
      totalBet: 0,
      acted: false,
    })),
    button,
    phase: 'waiting',
    community: [],
    deck: [],
    currentBet: 0,
    lastRaiseSize: config.bigBlind,
    actor: null,
    handNumber: 0,
    result: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers

function clone(state: GameState): GameState {
  return structuredClone(state);
}

/** Player was dealt in and has not folded. */
function inHand(p: PlayerState): boolean {
  return !p.out && !p.folded && p.hole !== null;
}

/** Player can still make betting decisions this hand. */
function canAct(p: PlayerState): boolean {
  return inHand(p) && p.stack > 0;
}

/** Next seat index after `from` satisfying `pred`, scanning clockwise. */
function nextSeat(state: GameState, from: number, pred: (p: PlayerState) => boolean): number {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (pred(state.players[idx]!)) return idx;
  }
  throw new Error('no seat matches predicate');
}

function playerIndex(state: GameState, playerId: string): number {
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx === -1) throw new Error(`unknown player: ${playerId}`);
  return idx;
}

function commit(p: PlayerState, amount: number): number {
  const paid = Math.min(amount, p.stack);
  p.stack -= paid;
  p.streetBet += paid;
  p.totalBet += paid;
  return paid;
}

// ---------------------------------------------------------------------------
// Hand lifecycle

export function startHand(state: GameState, opts: StartHandOptions = {}): GameState {
  const s = clone(state);
  if (s.phase !== 'waiting') throw new Error('cannot start a hand while one is in progress');

  for (const p of s.players) {
    if (p.stack <= 0) p.out = true;
    p.folded = false;
    p.hole = null;
    p.streetBet = 0;
    p.totalBet = 0;
    p.acted = false;
  }
  s.community = [];
  s.result = null;

  const live = s.players.filter((p) => !p.out);
  if (live.length < 2) throw new Error('need at least 2 players with chips to start a hand');

  // Rotate the button past busted seats (first hand keeps the configured button
  // unless that seat is busted).
  if (s.handNumber > 0 || s.players[s.button]!.out) {
    s.button = nextSeat(s, s.button, (p) => !p.out);
  }

  s.deck = opts.deck ? [...opts.deck] : shuffle(makeDeck(), opts.rng ?? Math.random);
  if (s.deck.length < live.length * 2 + 5) throw new Error('deck too small');

  // Deal two consecutive cards per player, starting left of the button.
  let seat = s.button;
  for (let i = 0; i < live.length; i++) {
    seat = nextSeat(s, seat, (p) => !p.out);
    s.players[seat]!.hole = [s.deck.shift()!, s.deck.shift()!];
  }

  // Blinds. Heads-up: the button is the small blind.
  const headsUp = live.length === 2;
  const sbSeat = headsUp ? nextSeat(s, s.button - 1, (p) => !p.out) : nextSeat(s, s.button, (p) => !p.out);
  const bbSeat = nextSeat(s, sbSeat, (p) => !p.out);
  commit(s.players[sbSeat]!, s.config.smallBlind);
  commit(s.players[bbSeat]!, s.config.bigBlind);

  s.currentBet = s.config.bigBlind;
  s.lastRaiseSize = s.config.bigBlind;
  s.phase = 'preflop';
  s.handNumber++;
  s.actor = null;

  return resumeAfterAction(s, bbSeat);
}

/**
 * After a state change, either hand the turn to the next player, advance the
 * street, or finish the hand. `lastSeat` is the seat that acted last (or the
 * big blind at hand start).
 */
function resumeAfterAction(s: GameState, lastSeat: number): GameState {
  const contenders = s.players.filter(inHand);

  if (contenders.length === 1) {
    return finishUncontested(s);
  }
  if (isBettingRoundDone(s)) {
    return advanceStreet(s);
  }
  s.actor = nextSeat(
    s,
    lastSeat,
    (p) => canAct(p) && !(p.acted && p.streetBet === s.currentBet),
  );
  return s;
}

function isBettingRoundDone(s: GameState): boolean {
  const actors = s.players.filter(canAct);
  if (actors.length === 0) return true;
  if (actors.length === 1) {
    // No one can respond to further action; done once this player has
    // matched the current bet. (They keep the option to act while facing
    // a live bet they haven't matched.)
    const p = actors[0]!;
    if (p.streetBet < s.currentBet) return false;
    // Pre-flop big blind still gets its option only if someone could call
    // a raise — with everyone else all-in or folded, betting is moot.
    return true;
  }
  return actors.every((p) => p.acted && p.streetBet === s.currentBet);
}

function advanceStreet(s: GameState): GameState {
  for (const p of s.players) {
    p.streetBet = 0;
    p.acted = false;
  }
  s.currentBet = 0;
  s.lastRaiseSize = s.config.bigBlind;
  s.actor = null;

  if (s.phase === 'preflop') {
    s.phase = 'flop';
    s.community.push(s.deck.shift()!, s.deck.shift()!, s.deck.shift()!);
  } else if (s.phase === 'flop') {
    s.phase = 'turn';
    s.community.push(s.deck.shift()!);
  } else if (s.phase === 'turn') {
    s.phase = 'river';
    s.community.push(s.deck.shift()!);
  } else if (s.phase === 'river') {
    return finishShowdown(s);
  } else {
    throw new Error(`cannot advance street from phase ${s.phase}`);
  }

  // With fewer than two players able to act there is no more betting:
  // run the board out.
  const actors = s.players.filter(canAct);
  if (actors.length < 2) {
    return advanceStreet(s);
  }
  s.actor = nextSeat(s, s.button, canAct);
  return s;
}

function finishUncontested(s: GameState): GameState {
  const winnerIdx = s.players.findIndex(inHand);
  const winner = s.players[winnerIdx]!;
  const total = s.players.reduce((sum, p) => sum + p.totalBet, 0);
  winner.stack += total;
  s.result = {
    pots: [
      {
        amount: total,
        eligible: [winner.id],
        winners: [winner.id],
        shares: { [winner.id]: total },
      },
    ],
    showdown: false,
    revealed: null,
  };
  return endHand(s);
}

function finishShowdown(s: GameState): GameState {
  const pots = computePots(
    s.players.map((p) => ({ contributed: p.totalBet, eligible: inHand(p) })),
  );

  const revealed: NonNullable<HandResult['revealed']> = {};
  const values = new Map<number, number>();
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i]!;
    if (!inHand(p)) continue;
    const hv = evaluateHand([...p.hole!, ...s.community]);
    values.set(i, hv.value);
    revealed[p.id] = { hole: p.hole!, value: hv.value, name: hv.name, best: hv.best };
  }

  const potResults: PotResult[] = [];
  for (const pot of pots) {
    const bestValue = Math.max(...pot.eligible.map((i) => values.get(i)!));
    const winnerIdxs = pot.eligible.filter((i) => values.get(i) === bestValue);

    const shares: Record<string, number> = {};
    const base = Math.floor(pot.amount / winnerIdxs.length);
    let remainder = pot.amount - base * winnerIdxs.length;
    for (const i of winnerIdxs) shares[s.players[i]!.id] = base;
    // Odd chips go to the earliest winners left of the button.
    let seat = s.button;
    while (remainder > 0) {
      seat = nextSeat(s, seat, () => true);
      if (winnerIdxs.includes(seat)) {
        shares[s.players[seat]!.id]! += 1;
        remainder--;
      }
    }

    for (const i of winnerIdxs) s.players[i]!.stack += shares[s.players[i]!.id]!;
    potResults.push({
      amount: pot.amount,
      eligible: pot.eligible.map((i) => s.players[i]!.id),
      winners: winnerIdxs.map((i) => s.players[i]!.id),
      shares,
    });
  }

  s.result = { pots: potResults, showdown: true, revealed };
  return endHand(s);
}

function endHand(s: GameState): GameState {
  s.phase = 'waiting';
  s.actor = null;
  s.currentBet = 0;
  s.deck = [];
  for (const p of s.players) {
    p.streetBet = 0;
    p.totalBet = 0;
    p.acted = false;
    if (p.stack <= 0) p.out = true;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Actions

export function legalActions(state: GameState): LegalActions {
  if (state.actor === null) throw new Error('no player to act');
  const p = state.players[state.actor]!;
  const toCall = state.currentBet - p.streetBet;
  const maxTo = p.streetBet + p.stack;

  const check = toCall === 0;
  const callAmount = toCall > 0 ? Math.min(toCall, p.stack) : null;

  let raise: LegalActions['raise'] = null;
  // A player may bet/raise if they can exceed the current bet and the action
  // has not been closed to them (p.acted is reset by every full raise; an
  // under-raise all-in leaves it set).
  if (maxTo > state.currentBet && !p.acted) {
    const minTo = Math.min(state.currentBet + state.lastRaiseSize, maxTo);
    raise = { minTo, maxTo };
  }

  return { fold: true, check, callAmount, raise };
}

export function applyAction(state: GameState, playerId: string, action: Action): GameState {
  const s = clone(state);
  if (s.phase === 'waiting') throw new Error('no hand in progress');
  if (s.actor === null) throw new Error('no player to act');

  const idx = playerIndex(s, playerId);
  if (idx !== s.actor) throw new Error(`out of turn: it is not ${playerId}'s turn`);

  const p = s.players[idx]!;
  const legal = legalActions(s);

  switch (action.type) {
    case 'fold': {
      p.folded = true;
      break;
    }
    case 'check': {
      if (!legal.check) throw new Error('cannot check facing a bet');
      break;
    }
    case 'call': {
      if (legal.callAmount === null) throw new Error('nothing to call');
      commit(p, s.currentBet - p.streetBet);
      break;
    }
    case 'raise': {
      if (!legal.raise) throw new Error('raising is not allowed');
      const { minTo, maxTo } = legal.raise;
      if (!Number.isInteger(action.to)) throw new Error('raise amount must be an integer');
      if (action.to > maxTo) throw new Error(`raise to ${action.to} exceeds stack (max ${maxTo})`);
      // Below-minimum raises are only legal as an all-in.
      if (action.to < minTo && action.to !== maxTo) {
        throw new Error(`raise to ${action.to} is below minimum ${minTo}`);
      }
      if (action.to <= s.currentBet) throw new Error('raise must exceed the current bet');

      const raiseSize = action.to - s.currentBet;
      commit(p, action.to - p.streetBet);
      s.currentBet = action.to;
      if (raiseSize >= s.lastRaiseSize) {
        // Full raise: reopens the action for everyone else.
        s.lastRaiseSize = raiseSize;
        for (const other of s.players) {
          if (other !== p) other.acted = false;
        }
      }
      break;
    }
    default:
      throw new Error(`unknown action type: ${(action as { type: string }).type}`);
  }

  p.acted = true;
  return resumeAfterAction(s, idx);
}

/**
 * The action a stalled player is forced to take on timeout:
 * check when free, otherwise fold. The transport layer owns the timer.
 */
export function defaultAction(state: GameState): Action {
  return legalActions(state).check ? { type: 'check' } : { type: 'fold' };
}

/** Total chips in play (stacks plus live bets); invariant across all transitions. */
export function totalChips(state: GameState): number {
  return state.players.reduce((sum, p) => sum + p.stack + p.totalBet, 0);
}

/**
 * A copy of the state safe to send to one player: the deck and every other
 * player's hole cards are hidden. After a showdown, `result.revealed`
 * still discloses showdown hands, as at a real table.
 */
export function redactStateFor(state: GameState, playerId: string): GameState {
  const s = clone(state);
  s.deck = [];
  for (const p of s.players) {
    if (p.id !== playerId) p.hole = null;
  }
  return s;
}

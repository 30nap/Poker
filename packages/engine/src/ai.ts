/**
 * Baseline computer opponent.
 *
 * Pure and deterministic (all randomness flows through the injected RNG), so
 * it runs identically in the browser (offline mode) and on a server (bots).
 * Strategy: estimate hand equity by Monte Carlo sampling of opponent hands
 * and board run-outs, then compare it against the pot odds being offered,
 * with some randomized aggression so play is not exploitable by rote.
 */

import { Card, RNG } from './cards.js';
import { evaluateHand } from './evaluator.js';
import { Action, GameState, legalActions } from './game.js';

export interface AiOptions {
  rng?: RNG;
  /** Monte Carlo samples per decision (default 160). */
  samples?: number;
  /** 0..1; higher bets/raises more (default 0.5). */
  aggression?: number;
}

/**
 * Probability of holding the best hand at showdown versus `opponents`
 * uniformly random hands, estimated over `samples` run-outs. Ties count half.
 */
export function estimateEquity(
  hole: readonly Card[],
  community: readonly Card[],
  opponents: number,
  samples: number,
  rng: RNG,
): number {
  const known = new Set([...hole, ...community]);
  const rest: Card[] = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) rest.push(c);

  const boardNeed = 5 - community.length;
  const need = opponents * 2 + boardNeed;
  let score = 0;

  for (let s = 0; s < samples; s++) {
    // Partial Fisher-Yates: draw `need` distinct cards from the unseen pool.
    const pool = [...rest];
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const board = [...community, ...pool.slice(opponents * 2, opponents * 2 + boardNeed)];
    const hero = evaluateHand([...hole, ...board]).value;

    let bestOpponent = -1;
    for (let o = 0; o < opponents; o++) {
      const v = evaluateHand([pool[o * 2]!, pool[o * 2 + 1]!, ...board]).value;
      if (v > bestOpponent) bestOpponent = v;
    }
    if (hero > bestOpponent) score += 1;
    else if (hero === bestOpponent) score += 0.5;
  }
  return score / samples;
}

/** Decide an action for the current actor. Always returns a legal action. */
export function decideAction(state: GameState, opts: AiOptions = {}): Action {
  const rng = opts.rng ?? Math.random;
  const samples = opts.samples ?? 160;
  const aggression = opts.aggression ?? 0.5;

  if (state.actor === null) throw new Error('no player to act');
  const me = state.players[state.actor]!;
  const legal = legalActions(state);

  const opponents = state.players.filter(
    (p) => p !== me && !p.out && !p.folded && p.hole !== null,
  ).length;
  const equity = estimateEquity(me.hole!, state.community, opponents, samples, rng);

  const pot = state.players.reduce((sum, p) => sum + p.totalBet, 0);
  const toCall = legal.callAmount ?? 0;

  const raiseBy = (potFraction: number): Action | null => {
    if (!legal.raise) return null;
    const target = Math.round(
      state.currentBet + Math.max(pot * potFraction, state.config.bigBlind * 2),
    );
    const to = Math.max(legal.raise.minTo, Math.min(legal.raise.maxTo, target));
    return { type: 'raise', to };
  };

  const r = rng();

  if (toCall === 0) {
    // Nothing to call: value-bet strong hands, occasionally bluff, else check.
    const valueThreshold = 1 / (opponents + 1) + 0.17;
    if (equity >= valueThreshold && r < 0.4 + aggression * 0.5) {
      return raiseBy(0.6) ?? { type: 'check' };
    }
    if (equity < valueThreshold && r < 0.06 * aggression * 2) {
      return raiseBy(0.5) ?? { type: 'check' };
    }
    return { type: 'check' };
  }

  // Facing a bet: compare equity with the price being offered.
  const potOdds = toCall / (pot + toCall);

  if (equity < potOdds - 0.02) {
    // Occasionally peel a cheap card even when priced out slightly.
    const cheap = toCall <= state.config.bigBlind * 2;
    if (cheap && equity > potOdds - 0.1 && r < 0.25) return { type: 'call' };
    return { type: 'fold' };
  }
  if (equity > potOdds + 0.25 && equity > 0.45 && r < 0.35 + aggression * 0.4) {
    return raiseBy(0.7) ?? { type: 'call' };
  }
  return { type: 'call' };
}

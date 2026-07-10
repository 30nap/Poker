/**
 * Texas Hold'em hand evaluation.
 *
 * `evaluateHand` accepts 5, 6 or 7 cards and returns the strongest 5-card
 * hand. Strength is a single comparable integer: higher value wins, equal
 * values split. The value packs the hand category and up to five tiebreaker
 * ranks in base 13, so a straight comparison of two numbers is a complete
 * and correct hand comparison.
 */

import { Card, RANK_CHARS, rankOf, suitOf } from './cards.js';

export const HandCategory = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  ThreeOfAKind: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  FourOfAKind: 7,
  StraightFlush: 8,
} as const;

export type HandCategory = (typeof HandCategory)[keyof typeof HandCategory];

export const HAND_CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: 'High Card',
  [HandCategory.Pair]: 'Pair',
  [HandCategory.TwoPair]: 'Two Pair',
  [HandCategory.ThreeOfAKind]: 'Three of a Kind',
  [HandCategory.Straight]: 'Straight',
  [HandCategory.Flush]: 'Flush',
  [HandCategory.FullHouse]: 'Full House',
  [HandCategory.FourOfAKind]: 'Four of a Kind',
  [HandCategory.StraightFlush]: 'Straight Flush',
};

export interface HandValue {
  /** Comparable strength: higher wins, equal splits. */
  value: number;
  category: HandCategory;
  /** The best five cards making up the hand. */
  best: Card[];
  /** Human-readable description, e.g. "Full House" or "Royal Flush". */
  name: string;
}

function packValue(category: number, tiebreaks: number[]): number {
  let v = category;
  for (let i = 0; i < 5; i++) {
    v = v * 13 + (tiebreaks[i] ?? 0);
  }
  return v;
}

/**
 * Given sorted-descending unique ranks, return the high rank of a straight
 * they contain, or -1. Handles the wheel (A-5), where the ace plays low
 * and the straight's high card is the 5 (rank index 3).
 */
function straightHigh(uniqueRanksDesc: number[]): number {
  const ranks = uniqueRanksDesc;
  let run = 1;
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i]! === ranks[i - 1]! - 1) {
      run++;
      if (run >= 5) return ranks[i]! + 4;
    } else {
      run = 1;
    }
  }
  // Wheel: A,5,4,3,2 → ranks 12,3,2,1,0
  if (
    ranks.includes(12) &&
    ranks.includes(3) &&
    ranks.includes(2) &&
    ranks.includes(1) &&
    ranks.includes(0)
  ) {
    return 3;
  }
  return -1;
}

/** Evaluate exactly five cards. */
export function evaluate5(cards: readonly Card[]): { value: number; category: HandCategory } {
  if (cards.length !== 5) throw new Error('evaluate5 requires exactly 5 cards');

  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const isFlush = cards.every((c) => suitOf(c) === suitOf(cards[0]!));

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Groups ordered by count desc, then rank desc.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const uniqueDesc = groups.map((g) => g[0]).sort((a, b) => b - a);
  const sHigh = counts.size === 5 ? straightHigh(uniqueDesc) : -1;

  if (isFlush && sHigh !== -1) {
    return { value: packValue(HandCategory.StraightFlush, [sHigh]), category: HandCategory.StraightFlush };
  }
  const [g0, g1] = [groups[0]!, groups[1]];
  if (g0[1] === 4) {
    return {
      value: packValue(HandCategory.FourOfAKind, [g0[0], g1![0]]),
      category: HandCategory.FourOfAKind,
    };
  }
  if (g0[1] === 3 && g1 && g1[1] === 2) {
    return {
      value: packValue(HandCategory.FullHouse, [g0[0], g1[0]]),
      category: HandCategory.FullHouse,
    };
  }
  if (isFlush) {
    return { value: packValue(HandCategory.Flush, ranks), category: HandCategory.Flush };
  }
  if (sHigh !== -1) {
    return { value: packValue(HandCategory.Straight, [sHigh]), category: HandCategory.Straight };
  }
  if (g0[1] === 3) {
    const kickers = groups.slice(1).map((g) => g[0]);
    return {
      value: packValue(HandCategory.ThreeOfAKind, [g0[0], ...kickers]),
      category: HandCategory.ThreeOfAKind,
    };
  }
  if (g0[1] === 2 && g1 && g1[1] === 2) {
    const kicker = groups[2]![0];
    return {
      value: packValue(HandCategory.TwoPair, [g0[0], g1[0], kicker]),
      category: HandCategory.TwoPair,
    };
  }
  if (g0[1] === 2) {
    const kickers = groups.slice(1).map((g) => g[0]);
    return {
      value: packValue(HandCategory.Pair, [g0[0], ...kickers]),
      category: HandCategory.Pair,
    };
  }
  return { value: packValue(HandCategory.HighCard, ranks), category: HandCategory.HighCard };
}

// All C(n,5) index combinations for n in 5..7, computed once.
const COMBOS: Record<number, number[][]> = {};
for (let n = 5; n <= 7; n++) {
  const combos: number[][] = [];
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === 5) {
      combos.push([...chosen]);
      return;
    }
    for (let i = start; i < n; i++) {
      chosen.push(i);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  COMBOS[n] = combos;
}

/** Evaluate the best 5-card hand from 5, 6 or 7 cards. */
export function evaluateHand(cards: readonly Card[]): HandValue {
  const combos = COMBOS[cards.length];
  if (!combos) throw new Error(`evaluateHand requires 5-7 cards, got ${cards.length}`);

  let best: { value: number; category: HandCategory } | null = null;
  let bestCards: Card[] = [];
  for (const combo of combos) {
    const five = combo.map((i) => cards[i]!);
    const res = evaluate5(five);
    if (!best || res.value > best.value) {
      best = res;
      bestCards = five;
    }
  }

  let name: string = HAND_CATEGORY_NAMES[best!.category];
  if (best!.category === HandCategory.StraightFlush) {
    const high = Math.max(...bestCards.map(rankOf));
    const isWheel = bestCards.some((c) => rankOf(c) === 12) && bestCards.some((c) => rankOf(c) === 0);
    if (high === 12 && !isWheel) name = 'Royal Flush';
  }
  return { value: best!.value, category: best!.category, best: bestCards, name };
}

/** Convenience for tests/debugging: rank index → display char. */
export function rankChar(rank: number): string {
  return RANK_CHARS[rank]!;
}

/**
 * Card representation and deck utilities.
 *
 * A card is a number 0..51 encoded as `rank * 4 + suit`, where
 * rank 0..12 maps to 2..Ace and suit 0..3 maps to clubs/diamonds/hearts/spades.
 * The compact numeric form keeps game state JSON-serializable and cheap to clone.
 */

export type Card = number;

export const RANK_CHARS = '23456789TJQKA';
export const SUIT_CHARS = 'cdhs';

export function makeCard(rank: number, suit: number): Card {
  if (rank < 0 || rank > 12 || suit < 0 || suit > 3) {
    throw new Error(`invalid card rank=${rank} suit=${suit}`);
  }
  return rank * 4 + suit;
}

export function rankOf(card: Card): number {
  return Math.floor(card / 4);
}

export function suitOf(card: Card): number {
  return card % 4;
}

/** Format a card as a two-character string like "As" or "Td". */
export function cardToString(card: Card): string {
  return `${RANK_CHARS[rankOf(card)]}${SUIT_CHARS[suitOf(card)]}`;
}

/** Parse a two-character string like "As" or "Td" into a card. */
export function parseCard(s: string): Card {
  const rank = RANK_CHARS.indexOf(s[0]?.toUpperCase() ?? '');
  const suit = SUIT_CHARS.indexOf(s[1]?.toLowerCase() ?? '');
  if (rank === -1 || suit === -1) throw new Error(`invalid card string: ${s}`);
  return makeCard(rank, suit);
}

/** Parse a space-separated list of cards, e.g. "As Kd 7h". */
export function parseCards(s: string): Card[] {
  return s.trim().split(/\s+/).map(parseCard);
}

/** A fresh 52-card deck in canonical order. */
export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (let c = 0; c < 52; c++) deck.push(c);
  return deck;
}

/** Random number source returning values in [0, 1). Injectable for determinism. */
export type RNG = () => number;

/** Deterministic RNG (mulberry32) for seeded shuffles in tests and replays. */
export function seededRng(seed: number): RNG {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle; returns a new array. */
export function shuffle<T>(items: readonly T[], rng: RNG = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

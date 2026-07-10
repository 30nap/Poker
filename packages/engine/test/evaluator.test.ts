import { describe, expect, it } from 'vitest';
import { parseCards } from '../src/cards.js';
import { evaluateHand, HandCategory } from '../src/evaluator.js';

const evalStr = (s: string) => evaluateHand(parseCards(s));

describe('hand categories', () => {
  const ranked: [string, string, number][] = [
    ['royal flush', 'As Ks Qs Js Ts 2c 3d', HandCategory.StraightFlush],
    ['straight flush', '9h 8h 7h 6h 5h Ac Ad', HandCategory.StraightFlush],
    ['four of a kind', 'Qc Qd Qh Qs 2c 3d 4h', HandCategory.FourOfAKind],
    ['full house', 'Kc Kd Kh 2c 2d 5s 9h', HandCategory.FullHouse],
    ['flush', 'Ad Jd 9d 6d 2d Kc Qs', HandCategory.Flush],
    ['straight', 'Tc 9d 8h 7s 6c Ac Kd', HandCategory.Straight],
    ['three of a kind', '7c 7d 7h Ac Kd 2s 4h', HandCategory.ThreeOfAKind],
    ['two pair', 'Jc Jd 4h 4s Ac 8d 2h', HandCategory.TwoPair],
    ['pair', 'Ac Ad Kc 8d 6h 4s 2c', HandCategory.Pair],
    ['high card', 'Ac Kd 9h 7s 5c 3d 2h', HandCategory.HighCard],
  ];

  it.each(ranked)('%s is detected', (_name, cards, category) => {
    expect(evalStr(cards).category).toBe(category);
  });

  it('orders every category correctly', () => {
    for (let i = 0; i < ranked.length - 1; i++) {
      const stronger = evalStr(ranked[i]![1]);
      const weaker = evalStr(ranked[i + 1]![1]);
      expect(stronger.value).toBeGreaterThan(weaker.value);
    }
  });

  it('names a royal flush', () => {
    expect(evalStr('As Ks Qs Js Ts 2c 3d').name).toBe('Royal Flush');
    expect(evalStr('9h 8h 7h 6h 5h Ac Ad').name).toBe('Straight Flush');
  });
});

describe('straights', () => {
  it('detects the wheel (A-2-3-4-5) as the lowest straight', () => {
    const wheel = evalStr('Ac 2d 3h 4s 5c Kd Kh');
    expect(wheel.category).toBe(HandCategory.Straight);
    const sixHigh = evalStr('2c 3d 4h 5s 6c Kd Kh');
    expect(sixHigh.value).toBeGreaterThan(wheel.value);
  });

  it('does not treat A-K-Q-J with a low card as a straight around the corner', () => {
    const notStraight = evalStr('Qc Kd Ac 2h 3s 7d 9c');
    expect(notStraight.category).toBe(HandCategory.HighCard);
  });

  it('detects the steel wheel as a straight flush, below a 6-high straight flush', () => {
    const steelWheel = evalStr('Ah 2h 3h 4h 5h Kc Kd');
    expect(steelWheel.category).toBe(HandCategory.StraightFlush);
    expect(steelWheel.name).toBe('Straight Flush');
    const sixHighSf = evalStr('2h 3h 4h 5h 6h Kc Kd');
    expect(sixHighSf.value).toBeGreaterThan(steelWheel.value);
  });

  it('finds a straight hidden among paired ranks', () => {
    const hand = evalStr('9c 9d 8h 7s 6c 5d 9h');
    expect(hand.category).toBe(HandCategory.Straight);
  });
});

describe('tiebreakers', () => {
  it('compares flushes by all five cards', () => {
    const a = evalStr('As Ks 9s 6s 3s 2c 2d');
    const b = evalStr('Ah Kh 9h 6h 2h 3c 3d');
    expect(a.value).toBeGreaterThan(b.value);
  });

  it('flushes identical in ranks but different suits tie', () => {
    const a = evalStr('As Ks 9s 6s 3s 2c 2d');
    const b = evalStr('Ah Kh 9h 6h 3h 2c 2d');
    expect(a.value).toBe(b.value);
  });

  it('compares two pair by high pair, then low pair, then kicker', () => {
    const acesAndTwos = evalStr('Ac Ad 2h 2s 3c 5d 7h');
    const kingsAndQueens = evalStr('Kc Kd Qh Qs Jc 5d 7h');
    expect(acesAndTwos.value).toBeGreaterThan(kingsAndQueens.value);

    const jacksNinesAceKicker = evalStr('Jc Jd 9h 9s Ac 2d 3h');
    const jacksNinesKingKicker = evalStr('Jh Js 9c 9d Kc 2h 3s');
    expect(jacksNinesAceKicker.value).toBeGreaterThan(jacksNinesKingKicker.value);
  });

  it('picks the best two pair from three pairs in seven cards', () => {
    // Pairs of A, K and 2 → plays aces and kings with the best kicker (Q).
    const hand = evalStr('Ac Ad Kc Kd 2h 2s Qc');
    const explicit = evalStr('Ah As Kh Ks Qd 3c 4d');
    expect(hand.value).toBe(explicit.value);
  });

  it('compares full houses by trips first, then pair', () => {
    const twosFullOfAces = evalStr('2c 2d 2h Ac Ad 5s 9h');
    const acesFullOfTwos = evalStr('Ac Ad Ah 2c 2d 5s 9h');
    expect(acesFullOfTwos.value).toBeGreaterThan(twosFullOfAces.value);
  });

  it('picks the higher pair for a full house with two sets of trips', () => {
    // 777 and 444 in seven cards → 777 full of 44.
    const hand = evalStr('7c 7d 7h 4c 4d 4h Ac');
    const explicit = evalStr('7s 7c 7d 4s 4c 2h 3d');
    expect(hand.value).toBe(explicit.value);
  });

  it('compares quads by rank then kicker', () => {
    const quadTwosAce = evalStr('2c 2d 2h 2s Ac 5d 7h');
    const quadTwosKing = evalStr('2c 2d 2h 2s Kc 5d 7h');
    expect(quadTwosAce.value).toBeGreaterThan(quadTwosKing.value);
  });

  it('compares pairs by kickers in order', () => {
    const a = evalStr('8c 8d Ac Qd 9h 3s 2c');
    const b = evalStr('8h 8s Ad Qh 7c 3d 2h');
    expect(a.value).toBeGreaterThan(b.value);
  });

  it('only five cards play: sixth-card differences do not matter', () => {
    // Both hold the same best five (A K Q J 9 high card); the 6th/7th differ.
    const a = evalStr('Ac Kd Qh Js 9c 4d 2h');
    const b = evalStr('Ah Ks Qd Jc 9h 3s 2d');
    expect(a.value).toBe(b.value);
  });
});

describe('board plays / ties', () => {
  it('ties when the board is the best hand for both players', () => {
    const board = 'Ac Kd Qh Js Tc';
    const p1 = evalStr(`${board} 2c 3d`);
    const p2 = evalStr(`${board} 4h 5s`);
    expect(p1.category).toBe(HandCategory.Straight);
    expect(p1.value).toBe(p2.value);
  });

  it('counterfeited two pair: only the kicker decides on a double-paired board', () => {
    // Board: K K Q Q 9 — both play the board's two pair; A's ace kicker beats B's jack.
    const a = evalStr('Kc Kd Qh Qs 9c Ad 2h');
    const b = evalStr('Kc Kd Qh Qs 9c Jd 3h');
    expect(a.value).toBeGreaterThan(b.value);
  });
});

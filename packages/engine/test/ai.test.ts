import { describe, expect, it } from 'vitest';
import { parseCards, seededRng } from '../src/cards.js';
import { decideAction, estimateEquity } from '../src/ai.js';
import { applyAction, createGame, startHand, totalChips } from '../src/game.js';

describe('estimateEquity', () => {
  it('rates aces as a big favourite heads-up pre-flop', () => {
    const eq = estimateEquity(parseCards('As Ad'), [], 1, 500, seededRng(1));
    expect(eq).toBeGreaterThan(0.75);
    expect(eq).toBeLessThan(0.95);
  });

  it('rates 72o as a clear underdog heads-up pre-flop', () => {
    const eq = estimateEquity(parseCards('7c 2d'), [], 1, 500, seededRng(2));
    expect(eq).toBeLessThan(0.45);
  });

  it('equity drops as opponents are added', () => {
    const one = estimateEquity(parseCards('Ks Qs'), [], 1, 500, seededRng(3));
    const four = estimateEquity(parseCards('Ks Qs'), [], 4, 500, seededRng(3));
    expect(four).toBeLessThan(one);
  });

  it('gives the unbeatable nuts equity 1', () => {
    // Hero holds a royal flush; no opponent hand can beat or tie it.
    const eq = estimateEquity(
      parseCards('As Ks'),
      parseCards('Qs Js Ts 2d 3c'),
      2,
      200,
      seededRng(4),
    );
    expect(eq).toBe(1);
  });
});

describe('decideAction', () => {
  it('never folds aces heads-up when it can check or call cheaply', () => {
    for (let seed = 0; seed < 10; seed++) {
      let s = createGame(
        [
          { id: 'hero', stack: 1000 },
          { id: 'villain', stack: 1000 },
        ],
        { smallBlind: 5, bigBlind: 10 },
        0,
      );
      // Heads-up deal order: villain (BB) first, then hero (button/SB).
      s = startHand(s, { deck: parseCards('Ks Kd As Ad 2c 7d 9h 3s Jh') });
      const action = decideAction(s, { rng: seededRng(seed), samples: 200 });
      expect(action.type).not.toBe('fold');
    }
  });

  it('folds trash to a huge raise', () => {
    for (let seed = 0; seed < 10; seed++) {
      let s = createGame(
        [
          { id: 'hero', stack: 1000 },
          { id: 'villain', stack: 1000 },
        ],
        { smallBlind: 5, bigBlind: 10 },
        0,
      );
      // Hero (button) holds 72o and faces an all-in re-raise.
      s = startHand(s, { deck: parseCards('As Ad 7c 2d 5h 9s Jd 3c 8h') });
      s = applyAction(s, 'hero', { type: 'call' });
      s = applyAction(s, 'villain', { type: 'raise', to: 1000 });
      const action = decideAction(s, { rng: seededRng(seed), samples: 300 });
      expect(action.type).toBe('fold');
    }
  });

  it('plays entire games legally: seeded AI-vs-AI never makes an illegal move', () => {
    const rng = seededRng(99);
    let s = createGame(
      [
        { id: 'P0', stack: 500 },
        { id: 'P1', stack: 500 },
        { id: 'P2', stack: 500 },
      ],
      { smallBlind: 5, bigBlind: 10 },
      0,
    );

    for (let hand = 0; hand < 40; hand++) {
      if (s.players.filter((p) => p.stack > 0).length < 2) break;
      s = startHand(s, { rng });
      let guard = 0;
      while (s.phase !== 'waiting') {
        if (guard++ > 300) throw new Error('hand did not terminate');
        const actorId = s.players[s.actor!]!.id;
        // applyAction throws on any illegal action, so this is the assertion.
        s = applyAction(s, actorId, decideAction(s, { rng, samples: 40 }));
        expect(totalChips(s)).toBe(1500);
      }
      expect(s.result).not.toBeNull();
    }
  });
});

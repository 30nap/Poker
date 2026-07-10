import { describe, expect, it } from 'vitest';
import { computePots } from '../src/pots.js';

describe('computePots', () => {
  it('builds a single pot when contributions are equal', () => {
    const pots = computePots([
      { contributed: 100, eligible: true },
      { contributed: 100, eligible: true },
      { contributed: 100, eligible: true },
    ]);
    expect(pots).toEqual([{ amount: 300, eligible: [0, 1, 2] }]);
  });

  it('builds main and side pots for a three-way all-in with different stacks', () => {
    // P0 all-in 50, P1 all-in 200, P2 covers with 500.
    const pots = computePots([
      { contributed: 50, eligible: true },
      { contributed: 200, eligible: true },
      { contributed: 500, eligible: true },
    ]);
    expect(pots).toEqual([
      { amount: 150, eligible: [0, 1, 2] }, // 50 × 3
      { amount: 300, eligible: [1, 2] }, // 150 × 2
      { amount: 300, eligible: [2] }, // uncalled 300 returns to P2
    ]);
  });

  it('keeps folded players money in the pot but never makes them eligible', () => {
    const pots = computePots([
      { contributed: 100, eligible: true },
      { contributed: 100, eligible: false }, // folded
      { contributed: 100, eligible: true },
    ]);
    expect(pots).toEqual([{ amount: 300, eligible: [0, 2] }]);
  });

  it('merges slices created by a folded player at an intermediate level', () => {
    // Folder put in 60; live players put in 100 each. The 60 level would
    // split the pot into two slices with identical eligibility — merge them.
    const pots = computePots([
      { contributed: 100, eligible: true },
      { contributed: 60, eligible: false },
      { contributed: 100, eligible: true },
    ]);
    expect(pots).toEqual([{ amount: 260, eligible: [0, 2] }]);
  });

  it('handles an all-in short stack plus a folder', () => {
    const pots = computePots([
      { contributed: 30, eligible: true }, // short all-in
      { contributed: 100, eligible: false }, // folded after betting
      { contributed: 100, eligible: true },
      { contributed: 100, eligible: true },
    ]);
    expect(pots).toEqual([
      { amount: 120, eligible: [0, 2, 3] }, // 30 × 4
      { amount: 210, eligible: [2, 3] }, // 70 × 3
    ]);
  });

  it('conserves chips across arbitrary contribution patterns', () => {
    const entries = [
      { contributed: 13, eligible: true },
      { contributed: 250, eligible: false },
      { contributed: 77, eligible: true },
      { contributed: 250, eligible: true },
      { contributed: 0, eligible: false },
    ];
    const pots = computePots(entries);
    const total = pots.reduce((s, p) => s + p.amount, 0);
    expect(total).toBe(13 + 250 + 77 + 250);
    for (const pot of pots) expect(pot.eligible.length).toBeGreaterThan(0);
  });

  it('returns no pots when nobody contributed', () => {
    expect(computePots([{ contributed: 0, eligible: true }])).toEqual([]);
  });
});

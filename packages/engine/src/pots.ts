/**
 * Side-pot construction.
 *
 * Pots are derived from each player's total contribution to the hand rather
 * than tracked incrementally, which makes multi-way all-in accounting a pure
 * function of the final contributions. Folded players' chips stay in the
 * pots they contributed to, but folded players are never eligible to win.
 */

export interface PotEntry {
  /** Total chips this player put into the hand. */
  contributed: number;
  /** Whether this player can still win (not folded, not sitting out). */
  eligible: boolean;
}

export interface Pot {
  amount: number;
  /** Indices (into the input array) of players who can win this pot. */
  eligible: number[];
}

/**
 * Slice contributions into a main pot and side pots.
 *
 * Each distinct contribution level forms a slice; a slice's pot collects
 * min(contribution, level) - previousLevel from every player, and only
 * non-folded players who contributed at least that level can win it.
 * Adjacent slices with identical eligibility (e.g. levels created by a
 * folded player's dead money) are merged into one pot.
 */
export function computePots(entries: readonly PotEntry[]): Pot[] {
  const levels = [...new Set(entries.filter((e) => e.contributed > 0).map((e) => e.contributed))].sort(
    (a, b) => a - b,
  );

  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const e of entries) {
      amount += Math.max(0, Math.min(e.contributed, level) - prev);
    }
    const eligible = entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.eligible && e.contributed >= level)
      .map(({ i }) => i);

    const last = pots[pots.length - 1];
    // An empty-eligibility slice can only arise from dead money above every
    // live stack; fold it into the pot below so no chips are orphaned.
    if (last && (sameSet(last.eligible, eligible) || eligible.length === 0)) {
      last.amount += amount;
    } else {
      pots.push({ amount, eligible });
    }
    prev = level;
  }
  return pots;
}

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

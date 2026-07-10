import { describe, expect, it } from 'vitest';
import { parseCards, seededRng } from '../src/cards.js';
import {
  Action,
  applyAction,
  createGame,
  defaultAction,
  GameState,
  legalActions,
  redactStateFor,
  startHand,
  totalChips,
} from '../src/game.js';

/**
 * Dealing order: two consecutive cards per live player starting left of the
 * button (button last), then flop (3), turn, river — all from the deck front.
 */
const deck = (s: string) => parseCards(s);

/** Three-handed table: seats A(0), B(1), C(2), button on A → SB=B, BB=C, A acts first pre-flop. */
function threeHanded(stacks: [number, number, number] = [1000, 1000, 1000], blinds = { smallBlind: 5, bigBlind: 10 }) {
  return createGame(
    [
      { id: 'A', stack: stacks[0] },
      { id: 'B', stack: stacks[1] },
      { id: 'C', stack: stacks[2] },
    ],
    blinds,
    0,
  );
}

function player(state: GameState, id: string) {
  return state.players.find((p) => p.id === id)!;
}

function act(state: GameState, id: string, action: Action) {
  return applyAction(state, id, action);
}

// A board with no possible straight or flush interactions with test hole cards.
const DRY_BOARD = '2c 7d 9h 3s Jh';

describe('hand setup and blinds', () => {
  it('posts blinds and gives first pre-flop action to the player after the big blind', () => {
    let s = threeHanded();
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    expect(s.phase).toBe('preflop');
    expect(player(s, 'B').streetBet).toBe(5); // small blind
    expect(player(s, 'C').streetBet).toBe(10); // big blind
    expect(s.currentBet).toBe(10);
    expect(s.players[s.actor!]!.id).toBe('A');
    expect(player(s, 'A').hole).not.toBeNull();
    expect(totalChips(s)).toBe(3000);
  });

  it('deals two cards per player in seat order starting left of the button', () => {
    let s = threeHanded();
    // Deal order is B, C, A.
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });
    expect(player(s, 'B').hole).toEqual(parseCards('Ks Kd'));
    expect(player(s, 'C').hole).toEqual(parseCards('Qs Qd'));
    expect(player(s, 'A').hole).toEqual(parseCards('As Ad'));
  });

  it('heads-up: the button posts the small blind, acts first pre-flop and last post-flop', () => {
    let s = createGame(
      [
        { id: 'A', stack: 1000 },
        { id: 'B', stack: 1000 },
      ],
      { smallBlind: 5, bigBlind: 10 },
      0,
    );
    // Deal order heads-up with button on A: B first, then A.
    s = startHand(s, { deck: deck(`Ks Kd As Ad ${DRY_BOARD}`) });

    expect(player(s, 'A').streetBet).toBe(5); // button = small blind
    expect(player(s, 'B').streetBet).toBe(10);
    expect(s.players[s.actor!]!.id).toBe('A'); // button acts first pre-flop

    s = act(s, 'A', { type: 'call' });
    s = act(s, 'B', { type: 'check' });
    expect(s.phase).toBe('flop');
    expect(s.players[s.actor!]!.id).toBe('B'); // big blind acts first post-flop
  });

  it('cannot start a hand while one is in progress', () => {
    let s = threeHanded();
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });
    expect(() => startHand(s)).toThrow(/in progress/);
  });
});

describe('betting rounds', () => {
  it('plays a full hand to showdown; best hand wins the pot', () => {
    let s = threeHanded();
    // B: KK, C: QQ, A: AA; dry board → A wins.
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    s = act(s, 'A', { type: 'call' });
    s = act(s, 'B', { type: 'call' });
    s = act(s, 'C', { type: 'check' });
    expect(s.phase).toBe('flop');
    expect(s.community).toHaveLength(3);

    for (const street of ['turn', 'river', 'waiting'] as const) {
      s = act(s, 'B', { type: 'check' });
      s = act(s, 'C', { type: 'check' });
      s = act(s, 'A', { type: 'check' });
      expect(s.phase).toBe(street);
    }

    expect(s.result).not.toBeNull();
    expect(s.result!.showdown).toBe(true);
    expect(s.result!.pots).toEqual([
      { amount: 30, eligible: ['A', 'B', 'C'], winners: ['A'], shares: { A: 30 } },
    ]);
    expect(player(s, 'A').stack).toBe(1020);
    expect(player(s, 'B').stack).toBe(990);
    expect(player(s, 'C').stack).toBe(990);
    expect(s.result!.revealed!['A']!.name).toBe('Pair');
    expect(totalChips(s)).toBe(3000);
  });

  it('awards the pot uncontested when everyone else folds, without revealing cards', () => {
    let s = threeHanded();
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    s = act(s, 'A', { type: 'fold' });
    s = act(s, 'B', { type: 'fold' });

    expect(s.phase).toBe('waiting');
    expect(s.result!.showdown).toBe(false);
    expect(s.result!.revealed).toBeNull();
    expect(player(s, 'C').stack).toBe(1005); // wins the small blind
    expect(totalChips(s)).toBe(3000);
  });

  it('gives the big blind its option when everyone limps', () => {
    let s = threeHanded();
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    s = act(s, 'A', { type: 'call' });
    s = act(s, 'B', { type: 'call' });
    // Still pre-flop: the big blind may check or raise.
    expect(s.phase).toBe('preflop');
    expect(s.players[s.actor!]!.id).toBe('C');
    const legal = legalActions(s);
    expect(legal.check).toBe(true);
    expect(legal.raise).toEqual({ minTo: 20, maxTo: 1000 });

    s = act(s, 'C', { type: 'raise', to: 30 });
    // The raise reopens action for the limpers.
    expect(s.phase).toBe('preflop');
    expect(s.players[s.actor!]!.id).toBe('A');
  });

  it('enforces the minimum raise', () => {
    let s = threeHanded();
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    expect(() => act(s, 'A', { type: 'raise', to: 15 })).toThrow(/below minimum/);
    s = act(s, 'A', { type: 'raise', to: 30 }); // raise size 20
    // B must raise by at least 20, i.e. to 50.
    expect(legalActions(s).raise).toEqual({ minTo: 50, maxTo: 1000 });
    expect(() => act(s, 'B', { type: 'raise', to: 40 })).toThrow(/below minimum/);
    s = act(s, 'B', { type: 'raise', to: 50 });
    expect(s.currentBet).toBe(50);
  });

  it('a full raise reopens the action for players who already acted', () => {
    let s = threeHanded();
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    s = act(s, 'A', { type: 'raise', to: 100 });
    s = act(s, 'B', { type: 'raise', to: 300 });
    s = act(s, 'C', { type: 'fold' });
    // A already acted, but B's full raise reopens it.
    const legal = legalActions(s);
    expect(s.players[s.actor!]!.id).toBe('A');
    expect(legal.raise).toEqual({ minTo: 500, maxTo: 1000 });
  });

  it('an all-in below the minimum raise does not reopen the action', () => {
    let s = threeHanded([1000, 1000, 150]);
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    s = act(s, 'A', { type: 'raise', to: 100 }); // raise size 90
    s = act(s, 'B', { type: 'fold' });
    // C all-in to 150: raise size 50 < 90 → legal only because it's all-in.
    s = act(s, 'C', { type: 'raise', to: 150 });

    expect(s.players[s.actor!]!.id).toBe('A');
    const legal = legalActions(s);
    expect(legal.callAmount).toBe(50);
    expect(legal.raise).toBeNull(); // action not reopened
    expect(legal.fold).toBe(true);
  });

  it('rejects illegal actions', () => {
    let s = threeHanded();
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    expect(() => act(s, 'B', { type: 'fold' })).toThrow(/out of turn/);
    expect(() => act(s, 'A', { type: 'check' })).toThrow(/cannot check/);
    expect(() => act(s, 'A', { type: 'raise', to: 5000 })).toThrow(/exceeds stack/);
    expect(() => act(s, 'A', { type: 'raise', to: 20.5 })).toThrow(/integer/);

    s = act(s, 'A', { type: 'call' });
    s = act(s, 'B', { type: 'call' });
    s = act(s, 'C', { type: 'check' });
    // Post-flop, B to act with no bet outstanding.
    expect(() => act(s, 'B', { type: 'call' })).toThrow(/nothing to call/);
  });
});

describe('all-ins, side pots and split pots', () => {
  it('runs the board out when everyone is all-in and builds correct side pots', () => {
    // A covers (500), B all-in 200, C all-in 50.
    let s = threeHanded([500, 200, 50]);
    // B: KK, C: AA, A: QQ → C wins the main pot, B the side pot, A gets the rest back.
    s = startHand(s, { deck: deck(`Ks Kd As Ad Qs Qd ${DRY_BOARD}`) });

    s = act(s, 'A', { type: 'raise', to: 500 });
    s = act(s, 'B', { type: 'call' }); // all-in 200
    s = act(s, 'C', { type: 'call' }); // all-in 50

    expect(s.phase).toBe('waiting');
    expect(s.community).toHaveLength(5);
    expect(s.result!.showdown).toBe(true);
    expect(s.result!.pots).toEqual([
      { amount: 150, eligible: ['A', 'B', 'C'], winners: ['C'], shares: { C: 150 } },
      { amount: 300, eligible: ['A', 'B'], winners: ['B'], shares: { B: 300 } },
      // A's uncalled 300 comes back as a pot only A is eligible for.
      { amount: 300, eligible: ['A'], winners: ['A'], shares: { A: 300 } },
    ]);
    expect(player(s, 'A').stack).toBe(300);
    expect(player(s, 'B').stack).toBe(300);
    expect(player(s, 'C').stack).toBe(150);
    expect(totalChips(s)).toBe(750);
  });

  it('handles a big blind who is all-in from the blind itself', () => {
    // C has only 4 chips and is the big blind (10).
    let s = threeHanded([1000, 1000, 4]);
    // B: QQ, C: AA, A: KK → C wins the main pot, A wins the side pot.
    s = startHand(s, { deck: deck(`Qs Qd As Ad Ks Kd ${DRY_BOARD}`) });

    expect(s.currentBet).toBe(10); // the full big blind is still the bet to match
    s = act(s, 'A', { type: 'call' });
    s = act(s, 'B', { type: 'call' });

    // C is all-in from the blind and never acts; A and B check it down.
    expect(s.phase).toBe('flop');
    for (let street = 0; street < 3; street++) {
      s = act(s, 'B', { type: 'check' });
      s = act(s, 'A', { type: 'check' });
    }
    expect(s.phase).toBe('waiting');
    expect(s.result!.pots).toEqual([
      { amount: 12, eligible: ['A', 'B', 'C'], winners: ['C'], shares: { C: 12 } },
      { amount: 12, eligible: ['A', 'B'], winners: ['A'], shares: { A: 12 } },
    ]);
    expect(player(s, 'A').stack).toBe(1002);
    expect(player(s, 'B').stack).toBe(990);
    expect(player(s, 'C').stack).toBe(12);
    expect(totalChips(s)).toBe(2004);
  });

  it('splits a tied pot and gives the odd chip to the first winner left of the button', () => {
    let s = threeHanded([1000, 1000, 1000], { smallBlind: 1, bigBlind: 2 });
    // A and C hold the same pair of aces with identical kickers; B folds.
    // Deal order B, C, A.
    s = startHand(s, { deck: deck(`9c 9d As 3d Ah 3c Ac Kc Qd 7h 2s`) });

    s = act(s, 'A', { type: 'call' });
    s = act(s, 'B', { type: 'fold' });
    s = act(s, 'C', { type: 'check' });
    for (let street = 0; street < 3; street++) {
      s = act(s, 'C', { type: 'check' });
      s = act(s, 'A', { type: 'check' });
    }

    // Pot is 5 (A: 2, B: 1, C: 2). C sits left of the button, so C gets the odd chip.
    expect(s.result!.pots).toEqual([
      {
        amount: 5,
        eligible: ['A', 'C'],
        winners: ['A', 'C'],
        shares: { A: 2, C: 3 },
      },
    ]);
    expect(player(s, 'A').stack).toBe(1000);
    expect(player(s, 'C').stack).toBe(1001);
    expect(player(s, 'B').stack).toBe(999);
    expect(totalChips(s)).toBe(3000);
  });

  it('ties on the board split between all remaining players', () => {
    let s = threeHanded();
    // Board is a broadway straight that plays for everyone.
    s = startHand(s, { deck: deck(`2c 3c 2d 3d 2h 3h Tc Jc Qd Kd Ah`) });

    s = act(s, 'A', { type: 'call' });
    s = act(s, 'B', { type: 'call' });
    s = act(s, 'C', { type: 'check' });
    for (let street = 0; street < 3; street++) {
      s = act(s, 'B', { type: 'check' });
      s = act(s, 'C', { type: 'check' });
      s = act(s, 'A', { type: 'check' });
    }

    expect(s.result!.pots[0]!.winners).toEqual(['A', 'B', 'C']);
    expect(player(s, 'A').stack).toBe(1000);
    expect(player(s, 'B').stack).toBe(1000);
    expect(player(s, 'C').stack).toBe(1000);
  });
});

describe('button rotation and busted players', () => {
  it('moves the button, skips busted players, and marks them out', () => {
    let s = threeHanded([1000, 1000, 100]);
    // C: QQ loses to A: AA. B: KK folds pre-flop.
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    s = act(s, 'A', { type: 'raise', to: 100 });
    s = act(s, 'B', { type: 'fold' });
    s = act(s, 'C', { type: 'call' }); // all-in for 100 total

    expect(s.phase).toBe('waiting');
    expect(player(s, 'C').stack).toBe(0);

    // Next hand: C is out; the game is heads-up between A and B.
    s = startHand(s, { deck: deck(`As Ad Ks Kd ${DRY_BOARD}`) });
    expect(player(s, 'C').out).toBe(true);
    expect(player(s, 'C').hole).toBeNull();
    expect(s.button).toBe(1); // moved from A to B
    // Heads-up: button (B) is the small blind.
    expect(player(s, 'B').streetBet).toBe(5);
    expect(player(s, 'A').streetBet).toBe(10);
  });

  it('refuses to start a hand with fewer than two funded players', () => {
    let s = createGame(
      [
        { id: 'A', stack: 200 },
        { id: 'B', stack: 100 },
      ],
      { smallBlind: 5, bigBlind: 10 },
      0,
    );
    s = startHand(s, { deck: deck(`Ks Kd As Ad ${DRY_BOARD}`) });
    s = act(s, 'A', { type: 'raise', to: 200 });
    s = act(s, 'B', { type: 'call' }); // all-in, loses with KK vs AA

    expect(player(s, 'B').stack).toBe(0);
    expect(() => startHand(s)).toThrow(/at least 2 players/);
  });
});

describe('transport-layer helpers', () => {
  it('defaultAction checks when free and folds when facing a bet', () => {
    let s = threeHanded();
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    expect(defaultAction(s)).toEqual({ type: 'fold' }); // A faces the big blind
    s = act(s, 'A', { type: 'call' });
    s = act(s, 'B', { type: 'call' });
    expect(defaultAction(s)).toEqual({ type: 'check' }); // C has the option

    // Applying default actions always terminates the hand.
    let guard = 0;
    while (s.phase !== 'waiting') {
      if (guard++ > 50) throw new Error('hand did not terminate');
      s = applyAction(s, s.players[s.actor!]!.id, defaultAction(s));
    }
    expect(s.result).not.toBeNull();
  });

  it('redactStateFor hides the deck and other players hole cards', () => {
    let s = threeHanded();
    s = startHand(s, { deck: deck(`Ks Kd Qs Qd As Ad ${DRY_BOARD}`) });

    const view = redactStateFor(s, 'B');
    expect(view.deck).toEqual([]);
    expect(player(view, 'B').hole).toEqual(parseCards('Ks Kd'));
    expect(player(view, 'A').hole).toBeNull();
    expect(player(view, 'C').hole).toBeNull();
    // The original state is untouched.
    expect(player(s, 'A').hole).not.toBeNull();
  });
});

describe('chip conservation fuzz', () => {
  it('keeps total chips constant across hundreds of randomly played hands', () => {
    const rng = seededRng(1337);
    const freshGame = () =>
      createGame(
        [
          { id: 'P0', stack: 1000 },
          { id: 'P1', stack: 1000 },
          { id: 'P2', stack: 1000 },
          { id: 'P3', stack: 1000 },
        ],
        { smallBlind: 5, bigBlind: 10 },
        0,
      );
    let s = freshGame();
    const TOTAL = 4000;
    let handsPlayed = 0;

    for (let hand = 0; hand < 300; hand++) {
      // Random all-in-heavy play collapses a table quickly; restart with
      // fresh stacks whenever one player has won everything.
      if (s.players.filter((p) => p.stack > 0).length < 2) s = freshGame();
      s = startHand(s, { rng });
      handsPlayed++;

      let guard = 0;
      while (s.phase !== 'waiting') {
        if (guard++ > 500) throw new Error('hand did not terminate');
        const legal = legalActions(s);
        const actorId = s.players[s.actor!]!.id;

        const choices: Action[] = [{ type: 'fold' }];
        if (legal.check) choices.push({ type: 'check' }, { type: 'check' });
        if (legal.callAmount !== null) choices.push({ type: 'call' }, { type: 'call' });
        if (legal.raise) {
          const { minTo, maxTo } = legal.raise;
          const to = minTo + Math.floor(rng() * (maxTo - minTo + 1));
          choices.push({ type: 'raise', to });
        }
        s = applyAction(s, actorId, choices[Math.floor(rng() * choices.length)]!);
        expect(totalChips(s)).toBe(TOTAL);
      }

      expect(s.result).not.toBeNull();
      const awarded = s.result!.pots.reduce((sum, p) => sum + p.amount, 0);
      const shared = s.result!.pots.reduce(
        (sum, p) => sum + Object.values(p.shares).reduce((a, b) => a + b, 0),
        0,
      );
      expect(shared).toBe(awarded);
      expect(totalChips(s)).toBe(TOTAL);
      for (const p of s.players) expect(p.stack).toBeGreaterThanOrEqual(0);
    }

    expect(handsPlayed).toBe(300);
  });
});

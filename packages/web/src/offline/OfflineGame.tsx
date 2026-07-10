import { useEffect, useMemo, useState } from 'react';
import {
  applyAction,
  createGame,
  decideAction,
  GameState,
  redactStateFor,
  startHand,
} from '@poker/engine';
import { Table, summarizeResult } from '../components/Table';
import { DEFAULT_BANKROLL, loadBankroll, saveBankroll } from '../storage';

const HERO = 'you';
const AI_NAMES = ['Ava', 'Rex', 'Kit', 'Sol', 'Mia'];
const AI_STACK = 1000;
const BLINDS = { smallBlind: 5, bigBlind: 10 };
const NEXT_HAND_DELAY_MS = 4000;

function freshGame(opponents: number): GameState {
  const players = [
    { id: HERO, stack: loadBankroll() },
    ...Array.from({ length: opponents }, (_, i) => ({ id: `cpu-${i}`, stack: AI_STACK })),
  ];
  const game = createGame(players, BLINDS, Math.floor(Math.random() * players.length));
  return startHand(game);
}

export function OfflineGame({ opponents, onExit }: { opponents: number; onExit: () => void }) {
  const [game, setGame] = useState<GameState>(() => freshGame(opponents));

  const names = useMemo(() => {
    const map: Record<string, string> = { [HERO]: 'You' };
    for (let i = 0; i < opponents; i++) map[`cpu-${i}`] = AI_NAMES[i]!;
    return map;
  }, [opponents]);

  const hero = game.players.find((p) => p.id === HERO)!;
  const heroBusted = hero.stack <= 0 && game.phase === 'waiting';

  // Drive the game forward: AI turns while a hand runs, next deal between hands.
  useEffect(() => {
    if (game.phase === 'waiting') {
      saveBankroll(hero.stack);
      if (heroBusted) return; // wait for the rebuy button

      const t = setTimeout(() => {
        setGame((g) => {
          if (g.phase !== 'waiting') return g;
          const next = structuredClone(g);
          // Virtual chips: AI opponents re-buy automatically so the game goes on.
          for (const p of next.players) {
            if (p.id !== HERO && p.stack <= 0) {
              p.stack = AI_STACK;
              p.out = false;
            }
          }
          if (next.players.filter((p) => p.stack > 0).length < 2) return g;
          return startHand(next);
        });
      }, NEXT_HAND_DELAY_MS);
      return () => clearTimeout(t);
    }

    const actor = game.actor !== null ? game.players[game.actor]! : null;
    if (actor && actor.id !== HERO) {
      const t = setTimeout(() => {
        setGame((g) => {
          const a = g.actor !== null ? g.players[g.actor]! : null;
          if (!a || a.id === HERO || g.phase === 'waiting') return g;
          return applyAction(g, a.id, decideAction(g));
        });
      }, 550 + Math.random() * 800);
      return () => clearTimeout(t);
    }
  }, [game, hero.stack, heroBusted]);

  const view = useMemo(() => redactStateFor(game, HERO), [game]);

  return (
    <div className="screen">
      <header className="top-bar">
        <button className="btn tiny" onClick={onExit}>
          ← Leave table
        </button>
        <span className="top-title">Offline · blinds {BLINDS.smallBlind}/{BLINDS.bigBlind}</span>
        <span className="top-chips">🪙 {hero.stack + hero.totalBet}</span>
      </header>

      <Table
        view={view}
        heroId={HERO}
        names={names}
        onAction={(action) =>
          setGame((g) => {
            try {
              return applyAction(g, HERO, action);
            } catch {
              return g; // stale click (e.g. double-tap after the turn passed)
            }
          })
        }
      >
        {game.phase === 'waiting' && game.result && !heroBusted && (
          <div className="banner">
            {summarizeResult(game.result, names).map((line) => (
              <div key={line}>{line}</div>
            ))}
            <div className="banner-sub">Next hand…</div>
          </div>
        )}
        {heroBusted && (
          <div className="banner">
            <div>You're out of chips!</div>
            <button
              className="btn primary"
              onClick={() => {
                saveBankroll(DEFAULT_BANKROLL);
                setGame((g) => {
                  const next = structuredClone(g);
                  const h = next.players.find((p) => p.id === HERO)!;
                  h.stack = DEFAULT_BANKROLL;
                  h.out = false;
                  return next;
                });
              }}
            >
              Re-buy {DEFAULT_BANKROLL}
            </button>
          </div>
        )}
      </Table>
    </div>
  );
}

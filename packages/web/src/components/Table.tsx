import { ReactNode, useEffect, useState } from 'react';
import { Action, GameState, HandResult, legalActions, PlayerState } from '@poker/engine';
import { CardView } from './CardView';
import { ActionBar } from './ActionBar';

/** Seat coordinates (% of table area), index 0 = hero at bottom center. */
const SEAT_LAYOUTS: Record<number, { x: number; y: number }[]> = {
  2: [
    { x: 50, y: 84 },
    { x: 50, y: 16 },
  ],
  3: [
    { x: 50, y: 84 },
    { x: 14, y: 30 },
    { x: 86, y: 30 },
  ],
  4: [
    { x: 50, y: 84 },
    { x: 9, y: 50 },
    { x: 50, y: 14 },
    { x: 91, y: 50 },
  ],
  5: [
    { x: 50, y: 84 },
    { x: 9, y: 58 },
    { x: 22, y: 17 },
    { x: 78, y: 17 },
    { x: 91, y: 58 },
  ],
  6: [
    { x: 50, y: 84 },
    { x: 8, y: 60 },
    { x: 14, y: 20 },
    { x: 50, y: 13 },
    { x: 86, y: 20 },
    { x: 92, y: 60 },
  ],
};

/** Point pulled from a seat toward the table center, for bet pills and the dealer chip. */
function towardCenter(pos: { x: number; y: number }, f: number) {
  return { x: pos.x + (50 - pos.x) * f, y: pos.y + (44 - pos.y) * f };
}

export interface TableProps {
  /** Redacted game state (never contains cards the hero may not see). */
  view: GameState;
  heroId: string;
  names: Record<string, string>;
  connected?: Record<string, boolean>;
  /** Epoch ms when the current actor is auto-folded (online mode). */
  deadline?: number | null;
  onAction: (action: Action) => void;
  /** Overlay content, e.g. the hand-result banner. */
  children?: ReactNode;
}

export function Table({ view, heroId, names, connected, deadline, onAction, children }: TableProps) {
  const n = view.players.length;
  const heroIdx = Math.max(0, view.players.findIndex((p) => p.id === heroId));
  const layout = SEAT_LAYOUTS[Math.max(2, Math.min(6, n))]!;

  const pot = view.players.reduce((sum, p) => sum + p.totalBet, 0);
  const heroTurn = view.actor !== null && view.players[view.actor]!.id === heroId;
  const legal = heroTurn ? legalActions(view) : null;
  const winners = winnersOf(view.result);

  return (
    <div className="table-area">
      <div className="table-zone">
        <div className="table-felt" />
        <div className="community">
          {view.community.map((c, i) => (
            <CardView key={`${view.handNumber}-${i}`} card={c} delay={i * 90} />
          ))}
          {view.community.length === 0 && view.phase !== 'waiting' && (
            <div className="community-placeholder">PRE-FLOP</div>
          )}
        </div>
        {pot > 0 && <div className="pot-label">Pot {pot}</div>}

        {view.players.map((p, seatIdx) => {
          const displaySlot = (seatIdx - heroIdx + n) % n;
          const pos = layout[displaySlot]!;
          const isTurn = view.actor === seatIdx;
          return (
            <Seat
              key={p.id}
              player={p}
              name={names[p.id] ?? p.id}
              pos={pos}
              isHero={p.id === heroId}
              isTurn={isTurn}
              deadline={isTurn ? deadline ?? null : null}
              isWinner={winners.has(p.id)}
              disconnected={connected ? connected[p.id] === false : false}
              result={view.result}
            />
          );
        })}

        {view.players.map((p, seatIdx) => {
          if (p.streetBet <= 0) return null;
          const displaySlot = (seatIdx - heroIdx + n) % n;
          const pos = towardCenter(layout[displaySlot]!, 0.38);
          return (
            <div key={p.id} className="bet-pill" style={{ left: `${pos.x}%`, top: `${pos.y}%` }}>
              {p.streetBet}
            </div>
          );
        })}

        {view.phase !== 'waiting' && <DealerChip layout={layout} view={view} heroIdx={heroIdx} />}
        {children}
      </div>

      <ActionBar legal={legal} view={view} deadline={heroTurn ? deadline ?? null : null} onAction={onAction} />
    </div>
  );
}

function DealerChip({
  layout,
  view,
  heroIdx,
}: {
  layout: { x: number; y: number }[];
  view: GameState;
  heroIdx: number;
}) {
  const n = view.players.length;
  const displaySlot = (view.button - heroIdx + n) % n;
  const pos = towardCenter(layout[displaySlot]!, 0.22);
  return (
    <div className="dealer-chip" style={{ left: `${pos.x + 5}%`, top: `${pos.y}%` }} title="Dealer">
      D
    </div>
  );
}

function Seat({
  player: p,
  name,
  pos,
  isHero,
  isTurn,
  deadline,
  isWinner,
  disconnected,
  result,
}: {
  player: PlayerState;
  name: string;
  pos: { x: number; y: number };
  isHero: boolean;
  isTurn: boolean;
  deadline: number | null;
  isWinner: boolean;
  disconnected: boolean;
  result: HandResult | null;
}) {
  const revealed = result?.revealed?.[p.id];
  const hole = revealed?.hole ?? p.hole;
  const classes = [
    'seat',
    isHero && 'hero',
    isTurn && 'turn',
    isWinner && 'winner',
    p.folded && 'folded',
    p.out && 'out',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} style={{ left: `${pos.x}%`, top: `${pos.y}%` }}>
      <div className="seat-cards">
        {hole !== null && !p.folded && (
          <>
            <CardView card={hole[0]} small delay={0} />
            <CardView card={hole[1]} small delay={80} />
          </>
        )}
      </div>
      <div className="seat-plate">
        <span className="seat-name">
          {disconnected && <span title="Disconnected">⚠ </span>}
          {name}
        </span>
        <span className="seat-stack">
          {p.out ? 'Busted' : p.stack === 0 ? 'All-in' : p.stack}
        </span>
      </div>
      {p.folded && <div className="seat-status">Folded</div>}
      {isTurn && deadline !== null && <SeatTimer deadline={deadline} />}
      {revealed && isWinner && <div className="seat-hand-name">{revealed.name}</div>}
    </div>
  );
}

function SeatTimer({ deadline }: { deadline: number }) {
  const now = useNow(250);
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <div className="seat-timer">{left}s</div>;
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function winnersOf(result: HandResult | null): Set<string> {
  const winners = new Set<string>();
  if (!result) return winners;
  const meaningful = result.pots.filter(
    (pot) => result.pots.length === 1 || pot.eligible.length > 1,
  );
  for (const pot of meaningful) for (const w of pot.winners) winners.add(w);
  return winners;
}

/** One line per pot winner, e.g. "Ava wins 120 with Two Pair". */
export function summarizeResult(result: HandResult, names: Record<string, string>): string[] {
  const totals = new Map<string, number>();
  const meaningful = result.pots.filter(
    (pot) => result.pots.length === 1 || pot.eligible.length > 1,
  );
  for (const pot of meaningful) {
    for (const [id, amount] of Object.entries(pot.shares)) {
      totals.set(id, (totals.get(id) ?? 0) + amount);
    }
  }
  return [...totals.entries()].map(([id, amount]) => {
    const hand = result.revealed?.[id]?.name;
    return `${names[id] ?? id} wins ${amount}${hand ? ` with ${hand}` : ''}`;
  });
}

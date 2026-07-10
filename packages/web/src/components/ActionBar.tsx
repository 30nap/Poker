import { useEffect, useState } from 'react';
import { Action, GameState, LegalActions } from '@poker/engine';
import { useNow } from './Table';

export function ActionBar({
  legal,
  view,
  deadline,
  onAction,
}: {
  /** null when it is not the hero's turn. */
  legal: LegalActions | null;
  view: GameState;
  deadline: number | null;
  onAction: (action: Action) => void;
}) {
  const raise = legal?.raise ?? null;
  const [raiseTo, setRaiseTo] = useState(0);

  // Re-anchor the slider whenever a new raise decision appears.
  useEffect(() => {
    if (raise) setRaiseTo(raise.minTo);
  }, [raise?.minTo, raise?.maxTo, view.actor, view.currentBet]);

  if (!legal) {
    return (
      <div className="action-bar idle">
        {view.phase === 'waiting' ? 'Shuffling up…' : 'Waiting for other players…'}
      </div>
    );
  }

  const pot = view.players.reduce((sum, p) => sum + p.totalBet, 0);
  const isOpen = view.currentBet === 0;
  const clamp = (v: number) => (raise ? Math.max(raise.minTo, Math.min(raise.maxTo, Math.round(v))) : v);

  return (
    <div className="action-bar">
      {deadline !== null && <TimeBar deadline={deadline} />}
      <div className="action-buttons">
        <button className="btn danger" onClick={() => onAction({ type: 'fold' })}>
          Fold
        </button>
        {legal.check && (
          <button className="btn" onClick={() => onAction({ type: 'check' })}>
            Check
          </button>
        )}
        {legal.callAmount !== null && (
          <button className="btn primary" onClick={() => onAction({ type: 'call' })}>
            Call {legal.callAmount}
          </button>
        )}
        {raise && (
          <button className="btn raise" onClick={() => onAction({ type: 'raise', to: clamp(raiseTo) })}>
            {isOpen ? 'Bet' : 'Raise to'} {clamp(raiseTo)}
          </button>
        )}
      </div>
      {raise && (
        <div className="raise-controls">
          <input
            type="range"
            min={raise.minTo}
            max={raise.maxTo}
            value={clamp(raiseTo)}
            onChange={(e) => setRaiseTo(Number(e.target.value))}
          />
          <div className="raise-presets">
            <button className="btn tiny" onClick={() => setRaiseTo(raise.minTo)}>
              Min
            </button>
            <button className="btn tiny" onClick={() => setRaiseTo(clamp(view.currentBet + pot / 2))}>
              ½ Pot
            </button>
            <button className="btn tiny" onClick={() => setRaiseTo(clamp(view.currentBet + pot))}>
              Pot
            </button>
            <button className="btn tiny" onClick={() => setRaiseTo(raise.maxTo)}>
              All-in
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TimeBar({ deadline }: { deadline: number }) {
  const now = useNow(100);
  const TURN_MS = 30_000;
  const fraction = Math.max(0, Math.min(1, (deadline - now) / TURN_MS));
  return (
    <div className="time-bar">
      <div className="time-bar-fill" style={{ width: `${fraction * 100}%` }} />
    </div>
  );
}

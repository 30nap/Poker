import { useState } from 'react';
import { OfflineGame } from './offline/OfflineGame';
import { loadBankroll } from './storage';

type Screen = { kind: 'home' } | { kind: 'offline'; opponents: number };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });

  if (screen.kind === 'offline') {
    return <OfflineGame opponents={screen.opponents} onExit={() => setScreen({ kind: 'home' })} />;
  }
  return <Home onPlayOffline={(opponents) => setScreen({ kind: 'offline', opponents })} />;
}

function Home({ onPlayOffline }: { onPlayOffline: (opponents: number) => void }) {
  const [opponents, setOpponents] = useState(3);
  const bankroll = loadBankroll();

  return (
    <div className="home">
      <h1 className="home-title">
        <span className="suit-red">♥</span> Hold'em Poker <span className="suit-black">♠</span>
      </h1>
      <p className="home-sub">No-limit Texas Hold'em — play chips only, no real money.</p>

      <div className="home-card">
        <h2>Play vs Computer</h2>
        <p className="muted">
          Offline single-player. Your bankroll ({bankroll} chips) is saved on this device.
        </p>
        <label className="field">
          Opponents
          <select value={opponents} onChange={(e) => setOpponents(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} AI player{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary big" onClick={() => onPlayOffline(opponents)}>
          Deal Me In
        </button>
      </div>

      <div className="home-card">
        <h2>Play Online</h2>
        <p className="muted">Create a room and invite friends with a code.</p>
        <button className="btn big" disabled title="Coming in the online update">
          Coming Soon
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { OfflineGame } from './offline/OfflineGame';
import { loadActiveRoom } from './online/client';
import { OnlineScreen } from './online/OnlineScreen';
import { loadBankroll } from './storage';

type Screen =
  | { kind: 'home' }
  | { kind: 'offline'; opponents: number }
  | { kind: 'online'; initialCode?: string };

function initialScreen(): Screen {
  // Invite links look like https://host/?room=Q7WPD
  const room = new URLSearchParams(location.search).get('room');
  if (room) {
    history.replaceState(null, '', location.pathname);
    return { kind: 'online', initialCode: room.toUpperCase() };
  }
  // A tab that was seated at an online table rejoins it after a reload.
  const active = loadActiveRoom();
  if (active) return { kind: 'online', initialCode: active };
  return { kind: 'home' };
}

export function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen);

  if (screen.kind === 'offline') {
    return <OfflineGame opponents={screen.opponents} onExit={() => setScreen({ kind: 'home' })} />;
  }
  if (screen.kind === 'online') {
    return <OnlineScreen initialCode={screen.initialCode} onExit={() => setScreen({ kind: 'home' })} />;
  }
  return (
    <Home
      onPlayOffline={(opponents) => setScreen({ kind: 'offline', opponents })}
      onPlayOnline={() => setScreen({ kind: 'online' })}
    />
  );
}

function Home({
  onPlayOffline,
  onPlayOnline,
}: {
  onPlayOffline: (opponents: number) => void;
  onPlayOnline: () => void;
}) {
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
        <p className="muted">Create a room and invite friends with a code or link.</p>
        <button className="btn big" onClick={onPlayOnline}>
          Enter Online Lobby
        </button>
      </div>
    </div>
  );
}

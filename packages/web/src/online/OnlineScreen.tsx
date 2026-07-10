import { useEffect, useMemo, useRef, useState } from 'react';
import type { Action, GameState } from '@poker/engine';
import type { LobbyPlayer, ServerMsg } from '@poker/shared';
import { Table, summarizeResult } from '../components/Table';
import { loadPlayerName, savePlayerName } from '../storage';
import {
  clearActiveRoom,
  GameClient,
  loadActiveRoom,
  loadToken,
  saveActiveRoom,
  saveToken,
  type ConnectionStatus,
} from './client';

type Stage = 'entry' | 'lobby' | 'game';

interface GameView {
  state: GameState;
  deadline: number | null;
  names: Record<string, string>;
  connected: Record<string, boolean>;
}

export function OnlineScreen({ initialCode, onExit }: { initialCode?: string; onExit: () => void }) {
  const [stage, setStage] = useState<Stage>('entry');
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [name, setName] = useState(loadPlayerName());
  const [codeInput, setCodeInput] = useState(initialCode ?? '');
  const [error, setError] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [game, setGame] = useState<GameView | null>(null);

  const stageRef = useRef(stage);
  stageRef.current = stage;

  const clientRef = useRef<GameClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new GameClient({
      onStatus: setStatus,
      onMessage: (msg: ServerMsg) => {
        switch (msg.t) {
          case 'joined':
            setRoomCode(msg.code);
            setYou(msg.you);
            saveToken(msg.code, msg.token);
            saveActiveRoom(msg.code);
            setError(null);
            if (stageRef.current === 'entry') setStage('lobby');
            break;
          case 'lobby':
            setPlayers(msg.players);
            break;
          case 'state':
            setGame({
              state: msg.state,
              deadline: msg.deadline,
              names: msg.names,
              connected: msg.connected,
            });
            setStage('game');
            break;
          case 'error':
            // A stale rejoin (room expired or seat given up) goes back to entry.
            if (msg.code === 'room-not-found' && stageRef.current === 'entry') clearActiveRoom();
            setError(msg.msg);
            break;
          case 'pong':
            break;
        }
      },
    });
    // A tab that was already seated (reload, crash) rejoins automatically
    // with its session token as soon as the socket opens.
    const active = initialCode ?? loadActiveRoom();
    const token = active ? loadToken(active) : null;
    if (active && token) clientRef.current.setRejoin({ code: active, token });
  }

  // reopen() + disconnect() (not close) so a StrictMode dev remount — or any
  // future unmount/remount — reconnects and reclaims the seat via the token.
  useEffect(() => {
    clientRef.current!.reopen();
    return () => clientRef.current?.disconnect();
  }, []);

  const client = clientRef.current;

  const leave = () => {
    client.send({ t: 'leave' });
    client.close();
    clearActiveRoom();
    onExit();
  };

  if (stage === 'entry') {
    return (
      <Entry
        name={name}
        setName={setName}
        codeInput={codeInput}
        setCodeInput={setCodeInput}
        status={status}
        error={error}
        onCreate={() => {
          savePlayerName(name);
          setError(null);
          if (!client.send({ t: 'create', name })) setError('Not connected yet — try again.');
        }}
        onJoin={() => {
          savePlayerName(name);
          setError(null);
          const code = codeInput.trim().toUpperCase();
          if (code.length === 0) return setError('Enter a room code.');
          const token = loadToken(code);
          if (!client.send(token ? { t: 'join', code, token } : { t: 'join', code, name })) {
            setError('Not connected yet — try again.');
          }
        }}
        onBack={() => {
          client.close();
          onExit();
        }}
      />
    );
  }

  if (stage === 'lobby') {
    return (
      <Lobby
        code={roomCode!}
        you={you}
        players={players}
        status={status}
        error={error}
        onReady={(ready) => client.send({ t: 'ready', ready })}
        onStart={() => client.send({ t: 'start' })}
        onLeave={leave}
      />
    );
  }

  return (
    <GameStage
      game={game}
      you={you}
      status={status}
      error={error}
      onAction={(action: Action) => client.send({ t: 'action', action })}
      onLeave={leave}
    />
  );
}

// ---------------------------------------------------------------- screens

function StatusPill({ status }: { status: ConnectionStatus }) {
  if (status === 'open') return null;
  const text =
    status === 'reconnecting' ? 'Reconnecting…' : status === 'connecting' ? 'Connecting…' : 'Offline';
  return <div className="status-pill">{text}</div>;
}

function Entry(props: {
  name: string;
  setName: (v: string) => void;
  codeInput: string;
  setCodeInput: (v: string) => void;
  status: ConnectionStatus;
  error: string | null;
  onCreate: () => void;
  onJoin: () => void;
  onBack: () => void;
}) {
  return (
    <div className="home">
      <h1 className="home-title">Play Online</h1>
      <StatusPill status={props.status} />
      {props.error && <div className="error-box">{props.error}</div>}

      <div className="home-card">
        <label className="field">
          Your name
          <input
            value={props.name}
            maxLength={16}
            placeholder="Player"
            onChange={(e) => props.setName(e.target.value)}
          />
        </label>
      </div>

      <div className="home-card">
        <h2>Create a room</h2>
        <p className="muted">You'll get a code to share with friends.</p>
        <button className="btn primary big" onClick={props.onCreate}>
          Create Room
        </button>
      </div>

      <div className="home-card">
        <h2>Join a room</h2>
        <label className="field">
          Room code
          <input
            value={props.codeInput}
            maxLength={5}
            placeholder="e.g. Q7WPD"
            style={{ textTransform: 'uppercase' }}
            onChange={(e) => props.setCodeInput(e.target.value)}
          />
        </label>
        <button className="btn big" onClick={props.onJoin}>
          Join Room
        </button>
      </div>

      <button className="btn tiny" onClick={props.onBack}>
        ← Back
      </button>
    </div>
  );
}

function Lobby(props: {
  code: string;
  you: string | null;
  players: LobbyPlayer[];
  status: ConnectionStatus;
  error: string | null;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const me = props.players.find((p) => p.id === props.you);
  const allReady = props.players.length >= 2 && props.players.every((p) => p.ready);
  const inviteLink = useMemo(() => {
    const url = new URL(location.href);
    url.search = `?room=${props.code}`;
    return url.toString();
  }, [props.code]);

  return (
    <div className="home">
      <h1 className="home-title">Lobby</h1>
      <StatusPill status={props.status} />
      {props.error && <div className="error-box">{props.error}</div>}

      <div className="home-card">
        <h2>
          Room code: <span className="room-code">{props.code}</span>
        </h2>
        <p className="muted">Share the code or the invite link with your friends.</p>
        <button
          className="btn"
          onClick={() => {
            navigator.clipboard?.writeText(inviteLink).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied!' : 'Copy invite link'}
        </button>
      </div>

      <div className="home-card">
        <h2>Players</h2>
        <ul className="lobby-list">
          {props.players.map((p) => (
            <li key={p.id} className="lobby-row">
              <span>
                {p.name}
                {p.host && <span className="tag">host</span>}
                {p.id === props.you && <span className="tag you">you</span>}
                {!p.connected && <span className="tag warn">offline</span>}
              </span>
              <span className={p.ready ? 'ready yes' : 'ready'}>{p.ready ? 'Ready ✓' : 'Not ready'}</span>
            </li>
          ))}
        </ul>
        <button
          className={me?.ready ? 'btn big' : 'btn primary big'}
          onClick={() => props.onReady(!me?.ready)}
        >
          {me?.ready ? 'Not ready' : "I'm ready"}
        </button>
        {me?.host && (
          <button className="btn raise big" disabled={!allReady} onClick={props.onStart}>
            {allReady ? 'Start Game' : 'Waiting for everyone to be ready…'}
          </button>
        )}
      </div>

      <button className="btn tiny" onClick={props.onLeave}>
        ← Leave room
      </button>
    </div>
  );
}

function GameStage(props: {
  game: GameView | null;
  you: string | null;
  status: ConnectionStatus;
  error: string | null;
  onAction: (a: Action) => void;
  onLeave: () => void;
}) {
  const { game, you } = props;
  if (!game || !you) {
    return (
      <div className="home">
        <StatusPill status={props.status} />
        <p className="muted">Waiting for game state…</p>
      </div>
    );
  }

  const hero = game.state.players.find((p) => p.id === you);

  return (
    <div className="screen">
      <header className="top-bar">
        <button className="btn tiny" onClick={props.onLeave}>
          ← Leave
        </button>
        <span className="top-title">
          Online · blinds {game.state.config.smallBlind}/{game.state.config.bigBlind}
        </span>
        <span className="top-chips">🪙 {hero ? hero.stack + hero.totalBet : 0}</span>
      </header>
      <StatusPill status={props.status} />
      {props.error && <div className="error-box floating">{props.error}</div>}

      <Table
        view={game.state}
        heroId={you}
        names={game.names}
        connected={game.connected}
        deadline={game.deadline}
        onAction={props.onAction}
      >
        {game.state.phase === 'waiting' && game.state.result && (
          <div className="banner">
            {summarizeResult(game.state.result, game.names).map((line) => (
              <div key={line}>{line}</div>
            ))}
            <div className="banner-sub">Next hand…</div>
          </div>
        )}
      </Table>
    </div>
  );
}

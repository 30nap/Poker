import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { UNKNOWN_CARD } from '@poker/engine';
import type { ClientMsg, ServerMsg } from '@poker/shared';
import { createPokerServer, type PokerServer } from '../src/index.js';

/** Test client: buffers server messages and lets tests await specific ones. */
class TestClient {
  private ws: WebSocket;
  private queue: ServerMsg[] = [];
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  closed = false;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMsg;
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i !== -1) this.waiters.splice(i, 1)[0]!.resolve(msg);
      else this.queue.push(msg);
    });
    this.ws.on('close', () => (this.closed = true));
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Next message matching pred — checks buffered messages first. */
  async next<T extends ServerMsg['t']>(t: T, timeoutMs = 4000): Promise<Extract<ServerMsg, { t: T }>> {
    const pred = (m: ServerMsg) => m.t === t;
    const buffered = this.queue.findIndex(pred);
    if (buffered !== -1) {
      return this.queue.splice(buffered, 1)[0] as Extract<ServerMsg, { t: T }>;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${t}"`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMsg, { t: T }>);
        },
      });
    });
  }

  /** Drain messages of type t until one satisfying pred arrives. */
  async nextWhere<T extends ServerMsg['t']>(
    t: T,
    pred: (m: Extract<ServerMsg, { t: T }>) => boolean,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMsg, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const msg = await this.next(t, Math.max(1, deadline - Date.now()));
      if (pred(msg)) return msg;
    }
  }

  /** Drain until a state message satisfying pred arrives. */
  async nextStateWhere(
    pred: (m: Extract<ServerMsg, { t: 'state' }>) => boolean,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMsg, { t: 'state' }>> {
    return this.nextWhere('state', pred, timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

let server: PokerServer;
const clients: TestClient[] = [];

async function connect(): Promise<TestClient> {
  const c = new TestClient(server.port);
  clients.push(c);
  await c.open();
  return c;
}

/** Create a room with two ready players and start the game. */
async function startedHeadsUp(turnMs = 60_000) {
  server = await createPokerServer({ turnMs, interHandMs: 60_000 });
  const alice = await connect();
  alice.send({ t: 'create', name: 'Alice' });
  const joinedA = await alice.next('joined');

  const bob = await connect();
  bob.send({ t: 'join', code: joinedA.code, name: 'Bob' });
  const joinedB = await bob.next('joined');

  alice.send({ t: 'ready', ready: true });
  bob.send({ t: 'ready', ready: true });
  // Messages from different sockets have no ordering guarantee: wait until
  // the server has registered both ready flags before starting.
  await alice.nextWhere('lobby', (m) => m.players.length === 2 && m.players.every((p) => p.ready));
  alice.send({ t: 'start' });

  const stateA = await alice.next('state');
  const stateB = await bob.next('state');
  return { alice, bob, joinedA, joinedB, stateA, stateB };
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
});

describe('rooms and lobby', () => {
  it('creates a room, joins by code, tracks ready state, and starts', async () => {
    server = await createPokerServer({});
    const alice = await connect();
    alice.send({ t: 'create', name: 'Alice' });
    const joined = await alice.next('joined');
    expect(joined.code).toMatch(/^[A-Z2-9]{5}$/);
    expect(joined.token).toBeTruthy();

    const lobby1 = await alice.next('lobby');
    expect(lobby1.players.map((p) => p.name)).toEqual(['Alice']);
    expect(lobby1.players[0]!.host).toBe(true);

    const bob = await connect();
    bob.send({ t: 'join', code: joined.code, name: 'Bob' });
    await bob.next('joined');
    const lobby2 = await bob.next('lobby');
    expect(lobby2.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);

    // Bob (not host) cannot start; unready room cannot start.
    bob.send({ t: 'start' });
    expect((await bob.next('error')).code).toBe('not-host');
    alice.send({ t: 'start' });
    expect((await alice.next('error')).code).toBe('not-ready');

    alice.send({ t: 'ready', ready: true });
    bob.send({ t: 'ready', ready: true });
    await alice.nextWhere('lobby', (m) => m.players.length === 2 && m.players.every((p) => p.ready));
    alice.send({ t: 'start' });

    const state = await alice.next('state');
    expect(state.state.phase).toBe('preflop');
    expect(state.deadline).toBeGreaterThan(Date.now());
  });

  it('rejects joining a nonexistent room and joining after start', async () => {
    const { joinedA } = await startedHeadsUp();

    const carol = await connect();
    carol.send({ t: 'join', code: 'XXXXX', name: 'Carol' });
    expect((await carol.next('error')).code).toBe('room-not-found');

    carol.send({ t: 'join', code: joinedA.code, name: 'Carol' });
    expect((await carol.next('error')).code).toBe('room-started');
  });
});

describe('gameplay over the wire', () => {
  it('redacts state per player: nobody ever sees an opponent hole card', async () => {
    const { joinedA, joinedB, stateA, stateB } = await startedHeadsUp();

    for (const [state, you] of [
      [stateA, joinedA.you],
      [stateB, joinedB.you],
    ] as const) {
      expect(state.state.deck).toEqual([]);
      for (const p of state.state.players) {
        if (p.id === you) {
          expect(p.hole![0]).toBeGreaterThanOrEqual(0);
          expect(p.hole![1]).toBeGreaterThanOrEqual(0);
        } else {
          expect(p.hole).toEqual([UNKNOWN_CARD, UNKNOWN_CARD]);
        }
      }
    }
  });

  it('applies actions in turn, rejects out-of-turn and illegal actions', async () => {
    const { alice, bob, joinedA, joinedB, stateA } = await startedHeadsUp();

    const actorId = stateA.state.players[stateA.state.actor!]!.id;
    const [actor, waiter, actorId2] =
      actorId === joinedA.you ? [alice, bob, joinedB.you] : [bob, alice, joinedA.you];

    // Out-of-turn action is rejected.
    waiter.send({ t: 'action', action: { type: 'fold' } });
    expect((await waiter.next('error')).code).toBe('bad-action');

    // Illegal action (check while facing the big blind) is rejected.
    actor.send({ t: 'action', action: { type: 'check' } });
    expect((await actor.next('error')).code).toBe('bad-action');

    // Legal call is applied and broadcast to both players.
    actor.send({ t: 'action', action: { type: 'call' } });
    const next = await waiter.nextStateWhere((m) => {
      const a = m.state.actor;
      return a !== null && m.state.players[a]!.id === actorId2;
    });
    expect(next.state.currentBet).toBe(10);
  });

  it('auto-folds (or checks) a player who times out', async () => {
    const { alice, bob } = await startedHeadsUp(500); // 0.5s turn clock

    // Nobody acts. The button (facing the blind) gets auto-folded, the
    // opponent wins the blinds and the hand ends.
    const done = await Promise.race([
      alice.nextStateWhere((m) => m.state.phase === 'waiting'),
      bob.nextStateWhere((m) => m.state.phase === 'waiting'),
    ]);
    expect(done.state.result).not.toBeNull();
    expect(done.state.result!.showdown).toBe(false);
    const stacks = done.state.players.map((p) => p.stack).sort((a, b) => a - b);
    expect(stacks).toEqual([995, 1005]);
  });
});

describe('reconnect', () => {
  it('reclaims the same seat with the session token and receives fresh state', async () => {
    const { alice, bob, joinedA } = await startedHeadsUp();

    alice.close();
    // Bob learns Alice disconnected.
    const seen = await bob.nextStateWhere((m) => m.connected[joinedA.you] === false);
    expect(seen.connected[joinedA.you]).toBe(false);

    const alice2 = await connect();
    alice2.send({ t: 'join', code: joinedA.code, token: joinedA.token });
    const rejoined = await alice2.next('joined');
    expect(rejoined.you).toBe(joinedA.you); // same seat, same player id

    const state = await alice2.next('state');
    const me = state.state.players.find((p) => p.id === joinedA.you)!;
    expect(me.hole![0]).toBeGreaterThanOrEqual(0); // own cards restored
    expect(state.connected[joinedA.you]).toBe(true);
  });

  it('rejects a reconnect with a bogus token', async () => {
    const { joinedA } = await startedHeadsUp();
    const stranger = await connect();
    stranger.send({ t: 'join', code: joinedA.code, token: 'not-a-real-token' });
    expect((await stranger.next('error')).code).toBe('room-not-found');
  });

  it('a player who leaves is folded and the game continues without them', async () => {
    const { alice, bob, joinedA, joinedB, stateA } = await startedHeadsUp();

    const actorId = stateA.state.players[stateA.state.actor!]!.id;
    const [leaver, stayer, stayerId] =
      actorId === joinedA.you ? [alice, bob, joinedB.you] : [bob, alice, joinedA.you];

    leaver.send({ t: 'leave' });
    const after = await stayer.nextStateWhere((m) => m.state.phase === 'waiting');
    // Heads-up: the leaver folds, the stayer wins the hand uncontested.
    expect(after.state.result!.pots[0]!.winners).toEqual([stayerId]);
  });
});

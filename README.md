# Poker — Texas Hold'em

A web-based no-limit Texas Hold'em game with two play modes:

- **Offline / single-player** — play against AI opponents entirely in the browser, no server required.
- **Online multiplayer** — real players in a room, synced over WebSocket.

## Architecture

The defining constraint: **the poker rules engine is completely independent of
transport and UI**. It is a pure TypeScript module with zero dependencies and
no I/O. Offline mode runs it directly in the browser; online mode runs the
exact same module on the server and syncs redacted state to clients.

```
packages/
  engine/   Pure poker rules engine (no UI, no network, no timers)  ← Phase 1 ✔
  web/      React + Vite frontend (offline mode + online client)    ← Phase 2/5
  server/   Node.js + ws room server (online mode)                  ← Phase 3/4
```

### Engine design (`@poker/engine`)

- **Pure state machine.** Game state is a plain JSON-serializable object.
  `startHand` and `applyAction` return new states and never mutate input —
  trivial to snapshot, sync, replay and test.
- **Deterministic.** Randomness enters only through an injectable RNG or an
  explicit deck, so every hand is reproducible.
- **No timers.** Turn timeouts belong to the transport layer, which calls
  `defaultAction(state)` (check if free, otherwise fold) for a stalled player.
- **Server-safe views.** `redactStateFor(state, playerId)` strips the deck and
  other players' hole cards, so online clients can never receive information
  they shouldn't have.

Key API:

```ts
import {
  createGame, startHand, applyAction, legalActions,
  defaultAction, redactStateFor, evaluateHand,
} from '@poker/engine';

let state = createGame([{ id: 'alice', stack: 1000 }, { id: 'bob', stack: 1000 }],
                       { smallBlind: 5, bigBlind: 10 });
state = startHand(state);
legalActions(state);                       // { fold, check, callAmount, raise: { minTo, maxTo } }
state = applyAction(state, 'alice', { type: 'raise', to: 30 });
```

Rules covered by the engine and its test suite:

- Full betting rounds (pre-flop / flop / turn / river) with check, bet, call,
  raise, all-in and fold.
- Minimum-raise enforcement; an all-in below the minimum raise is allowed but
  does **not** reopen the action for players who already acted.
- Side pots for multi-way all-ins, derived as a pure function of each player's
  total contribution (folded players' chips stay in the pot but never win).
- Showdown with correct hand ranking (including wheel straights, kicker
  battles, board-plays ties) and split pots, odd chips going to the first
  winner left of the button.
- Dealer button and blind rotation, heads-up blind rules (button posts the
  small blind), busted players skipped automatically.
- Automatic board run-out when betting is closed by all-ins.
- Chip-conservation invariant fuzz-tested over hundreds of randomly played
  hands with a seeded RNG.

## Development

```sh
npm install
npm test          # run all workspace test suites
```

## Roadmap

1. ✅ Core poker engine + unit tests
2. ⬜ Offline mode: React UI + pot-odds-aware AI
3. ⬜ Server + WebSocket sync for online mode
4. ⬜ Lobby, rooms, reconnect handling
5. ⬜ UI/UX polish and animations

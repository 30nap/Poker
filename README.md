# Poker — Texas Hold'em

A web-based no-limit Texas Hold'em game with two play modes:

- **Offline / single-player** — play against 1-5 AI opponents entirely in the
  browser: no server, no login, bankroll saved in localStorage.
- **Online multiplayer** — up to 6 real players in a room joined by code or
  invite link, synced over WebSocket with reconnect and turn timeouts.

## Architecture

The defining constraint: **the poker rules engine is completely independent of
transport and UI**. It is a pure TypeScript module with zero dependencies and
no I/O. Offline mode runs it directly in the browser; online mode runs the
exact same module on the server and syncs redacted state to clients.

```
packages/
  engine/   Pure poker rules engine + AI (no UI, no network, no timers)
  shared/   Typed WebSocket wire protocol shared by client and server
  web/      React + Vite frontend (offline game + online client)
  server/   Node.js + ws room server (lobby, rooms, timeouts, reconnect)
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

### Online mode design

- **Server is authoritative.** Clients send intents (`{ t: 'action', … }`);
  the server validates them against the engine and broadcasts each player's
  *redacted* view. Opponents' hole cards are `UNKNOWN_CARD` placeholders on
  the wire, so a cheating client has nothing to read.
- **Rooms** get 5-letter codes (no ambiguous characters) and invite links
  (`/?room=CODE`). A lobby with ready flags gates the start; the host deals.
- **Turn clock**: 30 s per decision, then the server checks/folds for the
  player (3 s for disconnected players so the table doesn't stall).
- **Reconnect**: each seat has a session token stored in `sessionStorage`;
  a page reload or dropped connection reclaims the same seat and cards
  automatically. Leaving for good folds the hand and frees the seat.
- Busted players re-buy automatically between hands — chips are virtual.

### AI (offline opponents)

`decideAction` estimates hand equity by Monte Carlo simulation against the
number of live opponents, compares it with the pot odds on offer, and mixes
in randomized aggression (value bets, occasional bluffs, min-raise handling).
Pure and seedable — the same module could drive server-side bots.

## Development

```sh
npm install
npm test                                  # engine + server test suites
npm run build                             # typecheck everything, bundle web

npm run dev   --workspace @poker/web      # offline mode at :5173 (proxies /ws)
npm run dev   --workspace @poker/server   # room server at :8080
npm run start --workspace @poker/server   # serves packages/web/dist too
```

Deploy = build the web app, run the server (single Node process) anywhere,
put both behind one origin; the client connects to `wss://<host>/ws`.

## Roadmap

1. ✅ Core poker engine + unit tests
2. ✅ Offline mode: React UI + pot-odds AI
3. ✅ Server + WebSocket sync for online mode
4. ✅ Lobby, rooms, reconnect handling
5. ✅ UI/UX polish and animations (deal/chip/turn/winner), mobile layout

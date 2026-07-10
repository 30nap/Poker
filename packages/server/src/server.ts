/**
 * HTTP + WebSocket server hosting poker rooms.
 *
 * Serves the built web client (if present) over HTTP and speaks the
 * @poker/shared protocol over WebSocket at /ws. All game logic lives in
 * @poker/engine via Room; this file only translates sockets to room calls.
 */

import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { sanitizeName, type ClientMsg, type ErrorCode, type ServerMsg } from '@poker/shared';
import { Room, RoomError, type RoomOptions, type Seat, type SeatConnection } from './room.js';
import { serveStatic } from './static.js';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const SWEEP_INTERVAL_MS = 60_000;
/** Rooms with every seat disconnected are destroyed after this long. */
const ABANDONED_TTL_MS = 5 * 60_000;

export interface PokerServerOptions extends RoomOptions {
  port?: number;
  /** Directory of the built web client to serve over HTTP (optional). */
  staticDir?: string;
}

export interface PokerServer {
  port: number;
  httpServer: Server;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

export async function createPokerServer(opts: PokerServerOptions = {}): Promise<PokerServer> {
  const rooms = new Map<string, Room>();
  const abandonedSince = new Map<string, number>();

  const httpServer = createServer((req, res) => serveStatic(req, res, opts.staticDir));
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const newRoomCode = (): string => {
    for (;;) {
      let code = '';
      for (let i = 0; i < 5; i++) {
        code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
      }
      if (!rooms.has(code)) return code;
    }
  };

  wss.on('connection', (ws: WebSocket & { isAlive?: boolean }) => {
    let room: Room | null = null;
    let seat: Seat | null = null;

    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    const conn: SeatConnection = {
      send(msg: ServerMsg) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        // Detach before closing so the close handler doesn't double-fire
        // disconnect logic for a seat that was taken over by a new socket.
        room = null;
        seat = null;
        ws.close();
      },
    };

    const fail = (code: ErrorCode, msg: string) => conn.send({ t: 'error', code, msg });

    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
        if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') throw new Error();
      } catch {
        fail('bad-message', 'messages must be JSON with a "t" field');
        return;
      }

      try {
        switch (msg.t) {
          case 'ping':
            conn.send({ t: 'pong' });
            break;

          case 'create': {
            if (seat) throw new RoomError('bad-message', 'already in a room');
            const created = new Room(newRoomCode(), opts);
            rooms.set(created.code, created);
            room = created;
            seat = created.join(sanitizeName(msg.name, 'Player'), conn);
            break;
          }

          case 'join': {
            if (seat) throw new RoomError('bad-message', 'already in a room');
            const code = String(msg.code ?? '').toUpperCase().trim();
            const target = rooms.get(code);
            if (!target) throw new RoomError('room-not-found', `no room with code ${code}`);
            room = target;
            seat = msg.token
              ? target.reconnect(msg.token, conn)
              : target.join(sanitizeName(msg.name, 'Player'), conn);
            break;
          }

          case 'ready':
            requireSeat().room.setReady(requireSeat().seat, Boolean(msg.ready));
            break;

          case 'start':
            requireSeat().room.start(requireSeat().seat);
            break;

          case 'action':
            requireSeat().room.handleAction(requireSeat().seat, msg.action);
            break;

          case 'leave': {
            const { room: r, seat: s } = requireSeat();
            room = null;
            seat = null;
            r.leave(s);
            ws.close();
            break;
          }

          default:
            fail('bad-message', `unknown message type`);
        }
      } catch (err) {
        if (err instanceof RoomError) fail(err.code, err.message);
        else fail('bad-message', 'internal error handling message');
      }
    });

    ws.on('close', () => {
      if (room && seat) room.disconnect(seat);
      room = null;
      seat = null;
    });

    function requireSeat(): { room: Room; seat: Seat } {
      if (!room || !seat) throw new RoomError('not-in-room', 'join a room first');
      return { room, seat };
    }
  });

  // Keepalive: terminate sockets that stop answering pings.
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      const s = ws as WebSocket & { isAlive?: boolean };
      if (s.isAlive === false) {
        s.terminate();
        continue;
      }
      s.isAlive = false;
      s.ping();
    }
  }, 30_000);

  // Garbage-collect rooms once everyone has been gone for a while.
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.activeSeats().length === 0) {
        room.destroy();
        rooms.delete(code);
        abandonedSince.delete(code);
        continue;
      }
      if (room.isAbandoned()) {
        const since = abandonedSince.get(code) ?? now;
        abandonedSince.set(code, since);
        if (now - since > ABANDONED_TTL_MS) {
          room.destroy();
          rooms.delete(code);
          abandonedSince.delete(code);
        }
      } else {
        abandonedSince.delete(code);
      }
    }
  }, SWEEP_INTERVAL_MS);

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);

  return {
    port,
    httpServer,
    rooms,
    async close() {
      clearInterval(pingTimer);
      clearInterval(sweepTimer);
      for (const room of rooms.values()) room.destroy();
      rooms.clear();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/**
 * Reconnecting WebSocket client for the room server.
 *
 * On an unexpected drop it retries with exponential backoff and, once
 * reopened, automatically re-joins the last room using the session token,
 * so a refresh or a flaky network puts the player straight back in their
 * seat.
 */

import type { ClientMsg, ServerMsg } from '@poker/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ClientCallbacks {
  onMessage: (msg: ServerMsg) => void;
  onStatus: (status: ConnectionStatus) => void;
}

const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export class GameClient {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempts = 0;
  private retryTimer: number | null = null;
  /** Last successful room entry; replayed with the token after a drop. */
  private rejoin: { code: string; token: string } | null = null;

  constructor(private readonly callbacks: ClientCallbacks) {}

  connect(): void {
    this.closedByUser = false;
    this.callbacks.onStatus(this.attempts > 0 ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.callbacks.onStatus('open');
      if (this.rejoin) {
        this.sendNow({ t: 'join', code: this.rejoin.code, token: this.rejoin.token });
      }
    };

    ws.onmessage = (event) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(event.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'joined') {
        this.rejoin = { code: msg.code, token: msg.token };
      }
      this.callbacks.onMessage(msg);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded by a newer socket
      this.ws = null;
      if (this.closedByUser) {
        this.callbacks.onStatus('closed');
        return;
      }
      this.callbacks.onStatus('reconnecting');
      const delay = Math.min(500 * 2 ** this.attempts++, 8000);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  /** Set (or clear) the room this client should re-enter after a drop. */
  setRejoin(rejoin: { code: string; token: string } | null): void {
    this.rejoin = rejoin;
  }

  /** Connect if not already connected. Safe to call repeatedly. */
  reopen(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.attempts = 0;
    this.connect();
  }

  send(msg: ClientMsg): boolean {
    return this.sendNow(msg);
  }

  private sendNow(msg: ClientMsg): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /**
   * Drop the socket but keep the rejoin info, so a later reopen() reclaims
   * the seat. Used by React effect cleanup (StrictMode remounts included).
   */
  disconnect(): void {
    this.closedByUser = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.callbacks.onStatus('closed');
  }

  /** Permanently leave: drop the socket and forget the seat. */
  close(): void {
    this.rejoin = null;
    this.disconnect();
  }
}

/** Session tokens per room code, so a page refresh can reclaim the seat. */
export function saveToken(code: string, token: string): void {
  try {
    sessionStorage.setItem(`poker.token.${code}`, token);
  } catch {
    // ignore
  }
}

export function loadToken(code: string): string | null {
  try {
    return sessionStorage.getItem(`poker.token.${code}`);
  } catch {
    return null;
  }
}

/**
 * The room this tab is currently seated in (sessionStorage, so each tab can
 * be its own player). Lets a reload land straight back at the table.
 */
const ACTIVE_ROOM_KEY = 'poker.activeRoom';

export function saveActiveRoom(code: string): void {
  try {
    sessionStorage.setItem(ACTIVE_ROOM_KEY, code);
  } catch {
    // ignore
  }
}

export function loadActiveRoom(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_ROOM_KEY);
  } catch {
    return null;
  }
}

export function clearActiveRoom(): void {
  try {
    sessionStorage.removeItem(ACTIVE_ROOM_KEY);
  } catch {
    // ignore
  }
}

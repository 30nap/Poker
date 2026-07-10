/** Local persistence for offline mode — no server, no login. */

const BANKROLL_KEY = 'poker.offline.bankroll';
const NAME_KEY = 'poker.name';

export const DEFAULT_BANKROLL = 1000;

export function loadBankroll(): number {
  try {
    const raw = localStorage.getItem(BANKROLL_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BANKROLL;
  } catch {
    return DEFAULT_BANKROLL;
  }
}

export function saveBankroll(chips: number): void {
  try {
    localStorage.setItem(BANKROLL_KEY, String(chips));
  } catch {
    // Storage unavailable (private browsing etc.) — play on without saving.
  }
}

export function loadPlayerName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function savePlayerName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // ignore
  }
}

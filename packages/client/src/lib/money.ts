// Money display/parse helpers. Balances are integer USD cents end-to-end.
import { translate, useLangStore } from './i18n.ts';

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Parse a user-entered dollar amount into integer cents, or null if invalid. */
export function parseDollarsToCents(input: string): number | null {
  const n = Number.parseFloat(input);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

const TX_KEY: Record<string, string> = {
  deposit: 'tx.deposit',
  withdrawal: 'tx.withdrawal',
  bet: 'tx.bet',
  payout: 'tx.payout',
  rake: 'tx.rake',
  purchase: 'tx.purchase',
  admin_adjust: 'tx.adminAdjust',
};

/** Localized transaction-type label. Reads the live language; callers (views using
 *  useT) re-render on a language change, so this re-resolves automatically. */
export function txLabel(type: string): string {
  const key = TX_KEY[type];
  return key ? translate(key, useLangStore.getState().lang) : type;
}

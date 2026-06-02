// Money display/parse helpers. Balances are integer USD cents end-to-end.

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Parse a user-entered dollar amount into integer cents, or null if invalid. */
export function parseDollarsToCents(input: string): number | null {
  const n = Number.parseFloat(input);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

const TX_LABEL: Record<string, string> = {
  deposit: 'Depozitë',
  withdrawal: 'Tërheqje',
  bet: 'Bast',
  payout: 'Fitim',
  rake: 'Komision',
  admin_adjust: 'Rregullim admin',
};

export function txLabel(type: string): string {
  return TX_LABEL[type] ?? type;
}

// House crypto receiving wallets shown on the deposit screen. These are PUBLIC
// receiving addresses (safe to ship to the client). Deposits to a shared address
// can't be auto-attributed to a user — an admin credits the balance after the
// funds arrive (see the note in WalletView). For automated, per-user crediting use
// a payment processor (NOWPayments / Coinbase Commerce) instead.
export interface CryptoWallet {
  id: string;
  icon: string;
  coin: string;     // e.g. 'BTC', 'USDT'
  network: string;  // human-readable network
  address: string;
}

export const CRYPTO_WALLETS: CryptoWallet[] = [
  { id: 'btc', icon: '₿', coin: 'BTC', network: 'Bitcoin', address: 'bc1q6xr5g7s9sffjjrlq3d2rwujshlgwztv96krfq5' },
  { id: 'usdt-trc', icon: '₮', coin: 'USDT', network: 'TRC-20 (Tron)', address: 'TDvSnoEfPihnfWUifoFGazDsfoJnVeVbo2' },
  { id: 'usdt-erc', icon: '₮', coin: 'USDT', network: 'ERC-20 (Ethereum)', address: '0x7848a4b2e9a1C244bD66D7Cdf3E365B1ebBaC8BE' },
];

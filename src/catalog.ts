import type { CatalogInstrument } from './types.js';

/**
 * Вселенная MDS: что провайдер реально стримит. Source of truth — ЗДЕСЬ
 * (поправка к ADR-024: цикл «MDS читает CMS, CMS выбирает из MDS» разорван —
 * CMS выбирает инструменты сайта ИЗ этой вселенной через /v1/instruments,
 * MDS от CMS не зависит вообще).
 * Расширение вселенной = новая строка (или провайдер №2 — форекс и т.д.).
 */

const CRYPTO_UNIVERSE: [symbol: string, name: string, digits: number][] = [
  ['BTCUSD', 'Bitcoin', 0],
  ['ETHUSD', 'Ethereum', 1],
  ['SOLUSD', 'Solana', 2],
  ['XRPUSD', 'Ripple', 4],
  ['BNBUSD', 'BNB', 1],
  ['ADAUSD', 'Cardano', 4],
  ['DOGEUSD', 'Dogecoin', 5],
  ['LTCUSD', 'Litecoin', 2],
  ['DOTUSD', 'Polkadot', 3],
  ['LINKUSD', 'Chainlink', 3],
  ['AVAXUSD', 'Avalanche', 2],
  ['TRXUSD', 'TRON', 5],
];

/** Канонический крипто-символ платформы → символ Binance. */
export function binanceSymbolFor(canonical: string): string {
  return canonical.replace(/USD$/, 'USDT').toLowerCase();
}

export const CATALOG: CatalogInstrument[] = CRYPTO_UNIVERSE.map(([symbol, name, digits]) => ({
  symbol,
  name,
  category: 'crypto' as const,
  digits,
  provider: 'binance' as const,
  providerSymbol: binanceSymbolFor(symbol),
}));

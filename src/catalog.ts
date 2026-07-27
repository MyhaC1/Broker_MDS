import type { CatalogInstrument, Quote, Segment } from './types.js';

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

/**
 * Вселенная Twelve Data: форекс/металлы/акции/индексы.
 * [символ платформы, имя, категория, сегмент, digits, символ провайдера].
 * Сегменты Европа/Азия/РФ по акциям и индексам добавляются сюда же,
 * когда тариф ключа их покроет (символ, отвергнутый тарифом, провайдер
 * сам уводит в чёрный список — строка не ломает остальных).
 */
const TWELVE_UNIVERSE: [
  symbol: string,
  name: string,
  category: Quote['category'],
  segment: Segment | null,
  digits: number,
  providerSymbol: string,
][] = [
  // Валюта — мажоры
  ['EURUSD', 'EUR/USD', 'forex', 'major', 5, 'EUR/USD'],
  ['GBPUSD', 'GBP/USD', 'forex', 'major', 5, 'GBP/USD'],
  ['USDJPY', 'USD/JPY', 'forex', 'major', 3, 'USD/JPY'],
  ['USDCHF', 'USD/CHF', 'forex', 'major', 5, 'USD/CHF'],
  ['AUDUSD', 'AUD/USD', 'forex', 'major', 5, 'AUD/USD'],
  ['USDCAD', 'USD/CAD', 'forex', 'major', 5, 'USD/CAD'],
  // Валюта — миноры
  ['EURGBP', 'EUR/GBP', 'forex', 'minor', 5, 'EUR/GBP'],
  ['EURJPY', 'EUR/JPY', 'forex', 'minor', 3, 'EUR/JPY'],
  // Валюта — экзотика
  ['USDTRY', 'USD/TRY', 'forex', 'exotic', 4, 'USD/TRY'],
  // Сырьё — металлы
  ['XAUUSD', 'Золото', 'metals', null, 2, 'XAU/USD'],
  ['XAGUSD', 'Серебро', 'metals', null, 3, 'XAG/USD'],
  // Акции — Америка
  ['AAPL', 'Apple', 'stocks', 'america', 2, 'AAPL'],
  ['MSFT', 'Microsoft', 'stocks', 'america', 2, 'MSFT'],
  ['NVDA', 'NVIDIA', 'stocks', 'america', 2, 'NVDA'],
  ['TSLA', 'Tesla', 'stocks', 'america', 2, 'TSLA'],
  // Индексы
  ['SPX', 'S&P 500', 'indices', 'america', 2, 'SPX'],
  ['DAX', 'DAX', 'indices', 'europe', 2, 'DAX'],
];

export const CATALOG: CatalogInstrument[] = [
  ...CRYPTO_UNIVERSE.map(([symbol, name, digits]) => ({
    symbol,
    name,
    category: 'crypto' as const,
    segment: null,
    digits,
    provider: 'binance' as const,
    providerSymbol: binanceSymbolFor(symbol),
  })),
  ...TWELVE_UNIVERSE.map(([symbol, name, category, segment, digits, providerSymbol]) => ({
    symbol,
    name,
    category,
    segment,
    digits,
    provider: 'twelvedata' as const,
    providerSymbol,
  })),
];

/* ------------------------------------------------------------------ */
/* Группировка для потребителей (селект в админке CMS и т.п.)          */
/* ------------------------------------------------------------------ */

const CATEGORY_RU: Record<Quote['category'], string> = {
  crypto: 'Криптовалюты',
  forex: 'Валюта',
  stocks: 'Акции',
  indices: 'Индексы',
  metals: 'Сырьё — металлы',
  energy: 'Сырьё — энергетика',
};

const SEGMENT_RU: Record<Segment, string> = {
  europe: 'Европа',
  asia: 'Азия',
  america: 'Америка',
  rf: 'РФ',
  major: 'Мажоры',
  minor: 'Миноры',
  exotic: 'Экзотика',
};

/**
 * Человекочитаемая метка группы инструмента («Акции — Европа»).
 * Уходит в /v1/instruments полем group: потребители группируют по ней
 * как по данным — новые категории/сегменты появляются у них
 * автоматически, без своих деплоев.
 */
export function groupLabelFor(i: Pick<CatalogInstrument, 'category' | 'segment'>): string {
  const category = CATEGORY_RU[i.category] ?? i.category;
  return i.segment ? `${category} — ${SEGMENT_RU[i.segment] ?? i.segment}` : category;
}

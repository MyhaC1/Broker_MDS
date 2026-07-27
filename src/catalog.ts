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

/** Красивые имена для мажоров (остальным — тикер базовой монеты). */
const CRYPTO_NAMES: Record<string, string> = Object.fromEntries(
  CRYPTO_UNIVERSE.map(([symbol, name]) => [symbol.replace(/USD$/, ''), name]),
);

/** Число знаков после запятой из tickSize Binance ("0.00010000" → 4). */
export function digitsFromTickSize(tickSize: string): number {
  const trimmed = tickSize.replace(/0+$/, '');
  const dot = trimmed.indexOf('.');
  return dot === -1 ? 0 : trimmed.length - dot - 1;
}

interface ExchangeInfoSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  isSpotTradingAllowed?: boolean;
  filters?: { filterType: string; tickSize?: string }[];
}

/**
 * Полная вселенная спота Binance к USDT из /api/v3/exchangeInfo
 * (решение пользователя — «вся крипта Binance»). Живые цены идут одним
 * стримом !ticker@arr, поэтому сотни пар почти ничего не стоят.
 * Плечевые токены (UP/DOWN/BULL/BEAR) исключены — их цена движется
 * обманчиво. Сеть недоступна → null, index падает на статический фолбэк.
 */
export async function fetchBinanceSpotUniverse(
  apiUrl: string,
): Promise<CatalogInstrument[] | null> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v3/exchangeInfo`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { symbols?: ExchangeInfoSymbol[] };

    const seen = new Set<string>();
    const out: CatalogInstrument[] = [];
    for (const s of data.symbols ?? []) {
      if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING') continue;
      if (s.isSpotTradingAllowed === false) continue;
      if (/(UP|DOWN|BULL|BEAR)$/.test(s.baseAsset)) continue;
      const canonical = `${s.baseAsset}USD`;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const tick = s.filters?.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize;
      out.push({
        symbol: canonical,
        name: CRYPTO_NAMES[s.baseAsset] ?? s.baseAsset,
        category: 'crypto',
        segment: null,
        digits: tick ? digitsFromTickSize(tick) : 2,
        provider: 'binance',
        providerSymbol: s.symbol.toLowerCase(),
      });
    }
    return out.length > 0 ? out : null;
  } catch (error) {
    console.warn('[binance] exchangeInfo fail:', (error as Error).message);
    return null;
  }
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

import { describe, expect, it } from 'vitest';
import { binanceSymbolFor, CATALOG } from './catalog.js';
import { normalizeTick } from './providers/binance.js';
import type { CatalogInstrument } from './types.js';

describe('вселенная инструментов', () => {
  it('канонический USD → binance USDT lowercase', () => {
    expect(binanceSymbolFor('BTCUSD')).toBe('btcusdt');
    expect(binanceSymbolFor('XRPUSD')).toBe('xrpusdt');
  });

  it('каталог статический, два провайдера, символы уникальны', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(29);
    expect(new Set(CATALOG.map((i) => i.symbol)).size).toBe(CATALOG.length);
    const crypto = CATALOG.filter((i) => i.category === 'crypto');
    expect(crypto.length).toBeGreaterThanOrEqual(12);
    expect(crypto.every((i) => i.provider === 'binance')).toBe(true);
    const twelve = CATALOG.filter((i) => i.provider === 'twelvedata');
    expect(twelve.length).toBeGreaterThanOrEqual(17);
    // Заявленная таксономия присутствует
    const has = (category: string, segment: string | null) =>
      CATALOG.some((i) => i.category === category && i.segment === segment);
    expect(has('forex', 'major') && has('forex', 'minor') && has('forex', 'exotic')).toBe(true);
    expect(has('stocks', 'america')).toBe(true);
    expect(has('indices', 'america') && has('indices', 'europe')).toBe(true);
    expect(has('metals', null)).toBe(true);
  });

  it('метка группы: категория и категория — сегмент', async () => {
    const { groupLabelFor } = await import('./catalog.js');
    expect(groupLabelFor({ category: 'crypto', segment: null })).toBe('Криптовалюты');
    expect(groupLabelFor({ category: 'stocks', segment: 'europe' })).toBe('Акции — Европа');
    expect(groupLabelFor({ category: 'forex', segment: 'exotic' })).toBe('Валюта — Экзотика');
    expect(groupLabelFor({ category: 'indices', segment: 'rf' })).toBe('Индексы — РФ');
  });

  it('у каждого инструмента вселенной есть иконка в public/icons', async () => {
    const { iconPathFor } = await import('./icons.js');
    for (const i of CATALOG) {
      expect(iconPathFor(i.symbol), i.symbol).toBe(`/icons/${i.symbol}.svg`);
    }
  });
});

describe('normalizeTwelveQuote (Twelve Data /quote → Quote контракта сайта)', () => {
  it('нормализует ответ /quote', async () => {
    const { normalizeTwelveQuote } = await import('./providers/twelvedata.js');
    const eurusd = CATALOG.find((i) => i.symbol === 'EURUSD')!;
    const quote = normalizeTwelveQuote(
      { symbol: 'EUR/USD', close: '1.08543', percent_change: '-0.25', timestamp: 1784990000 },
      eurusd,
    );
    expect(quote).toEqual({
      symbol: 'EURUSD',
      name: 'EUR/USD',
      category: 'forex',
      price: 1.08543,
      digits: 5,
      changePercent: -0.25,
      ts: 1784990000000,
    });
  });

  it('мусорная цена отбрасывается, отсутствующий percent_change → 0', async () => {
    const { normalizeTwelveQuote } = await import('./providers/twelvedata.js');
    const eurusd = CATALOG.find((i) => i.symbol === 'EURUSD')!;
    expect(normalizeTwelveQuote({ close: 'abc' }, eurusd)).toBeNull();
    expect(normalizeTwelveQuote({ close: '1.1' }, eurusd)?.changePercent).toBe(0);
  });
});

describe('normalizeTick (Binance @ticker → Quote контракта сайта)', () => {
  const bySymbol = new Map<string, CatalogInstrument>(CATALOG.map((i) => [i.providerSymbol, i]));

  it('нормализует тик в канонический Quote', () => {
    const quote = normalizeTick(
      { e: '24hrTicker', E: 1784990000000, s: 'BTCUSDT', c: '64034.52', P: '-1.497' },
      bySymbol,
    );
    expect(quote).toEqual({
      symbol: 'BTCUSD',
      name: 'Bitcoin',
      category: 'crypto',
      price: 64034.52,
      digits: 0,
      changePercent: -1.497,
      ts: 1784990000000,
    });
  });

  it('неизвестный символ и мусорные числа отбрасываются', () => {
    expect(normalizeTick({ e: '24hrTicker', E: 1, s: 'PEPEUSDT', c: '1', P: '1' }, bySymbol)).toBeNull();
    expect(normalizeTick({ e: '24hrTicker', E: 1, s: 'BTCUSDT', c: 'abc', P: '1' }, bySymbol)).toBeNull();
  });
});

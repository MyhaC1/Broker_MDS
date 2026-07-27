import { describe, expect, it } from 'vitest';
import { binanceSymbolFor, CATALOG } from './catalog.js';
import { normalizeTick } from './providers/binance.js';
import type { CatalogInstrument } from './types.js';

describe('вселенная инструментов', () => {
  it('канонический USD → binance USDT lowercase', () => {
    expect(binanceSymbolFor('BTCUSD')).toBe('btcusdt');
    expect(binanceSymbolFor('XRPUSD')).toBe('xrpusdt');
  });

  it('каталог статический, все — binance/crypto, символы уникальны', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(12);
    expect(CATALOG.every((i) => i.provider === 'binance' && i.category === 'crypto')).toBe(true);
    expect(new Set(CATALOG.map((i) => i.symbol)).size).toBe(CATALOG.length);
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

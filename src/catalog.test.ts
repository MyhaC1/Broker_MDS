import { describe, expect, it } from 'vitest';
import { binanceSymbolFor, FALLBACK_CATALOG, toCatalog } from './catalog.js';
import { normalizeTick } from './providers/binance.js';
import type { CatalogInstrument } from './types.js';

describe('маппинг символов', () => {
  it('канонический USD → binance USDT lowercase', () => {
    expect(binanceSymbolFor('BTCUSD')).toBe('btcusdt');
    expect(binanceSymbolFor('XRPUSD')).toBe('xrpusdt');
  });

  it('toCatalog берёт только крипту', () => {
    const catalog = toCatalog([
      { symbol: 'BTCUSD', name: 'Bitcoin', category: 'crypto', digits: 0 },
      { symbol: 'EURUSD', name: 'Euro', category: 'forex', digits: 5 },
    ]);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ symbol: 'BTCUSD', provider: 'binance', providerSymbol: 'btcusdt' });
  });

  it('фолбэк-каталог: 5 крипто-инструментов', () => {
    expect(FALLBACK_CATALOG).toHaveLength(5);
    expect(FALLBACK_CATALOG.every((i) => i.provider === 'binance')).toBe(true);
  });
});

describe('normalizeTick (Binance @ticker → Quote контракта сайта)', () => {
  const bySymbol = new Map<string, CatalogInstrument>(
    FALLBACK_CATALOG.map((i) => [i.providerSymbol, i]),
  );

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
    expect(normalizeTick({ e: '24hrTicker', E: 1, s: 'DOGEUSDT', c: '1', P: '1' }, bySymbol)).toBeNull();
    expect(normalizeTick({ e: '24hrTicker', E: 1, s: 'BTCUSDT', c: 'abc', P: '1' }, bySymbol)).toBeNull();
  });
});

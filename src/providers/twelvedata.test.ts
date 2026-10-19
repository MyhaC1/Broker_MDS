import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chunkSizeFor,
  normalizeTwelveQuote,
  pollIntervalMs,
  TwelveDataProvider,
  type TwelveDataConfig,
} from './twelvedata.js';
import type { CatalogInstrument, Quote } from '../types.js';

/**
 * Провайдер Twelve Data (MDS-04). Сеть подменена, потому что проверяется
 * поведение на ответах провайдера, а не сам HTTP.
 *
 * Числа-эталоны посчитаны **из определения тарифа, а не сняты с кода**:
 * ожидания, снятые с реализации, закрепляют её ошибку и остаются зелёными
 * навсегда. Расчёт для free-ключа приведён в тесте интервала.
 */

function instrument(symbol: string, providerSymbol: string): CatalogInstrument {
  return {
    symbol,
    name: symbol,
    category: 'forex',
    segment: 'major',
    digits: 5,
    provider: 'twelvedata',
    providerSymbol,
  };
}

const EURUSD = instrument('EURUSD', 'EUR/USD');
const GBPUSD = instrument('GBPUSD', 'GBP/USD');

const CFG: TwelveDataConfig = {
  id: 'twelvedata',
  apiKey: 'test-key',
  apiUrl: 'https://example.invalid',
  creditsPerMin: 8,
  creditsPerDay: 800,
};

const started: TwelveDataProvider[] = [];
afterEach(() => {
  for (const p of started.splice(0)) p.stop();
  vi.unstubAllGlobals();
});

function withResponses(...bodies: unknown[]) {
  const calls: string[] = [];
  let n = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const body = bodies[Math.min(n, bodies.length - 1)];
    n += 1;
    return { ok: true, json: async () => body } as Response;
  });
  return calls;
}

function provider(cfg: Partial<TwelveDataConfig> = {}, instruments = [EURUSD, GBPUSD]) {
  const quotes: Quote[] = [];
  const p = new TwelveDataProvider((q) => quotes.push(q), { ...CFG, ...cfg });
  p.setInstruments(instruments);
  started.push(p);
  return { p, quotes };
}

describe('бюджет кредитов считается из тарифа, а не из того, что выдаёт код', () => {
  it('free-ключ: 800/день, резерв 10% → 720 кредитов, чанк 8 → 16 минут', () => {
    // Независимый расчёт: 86 400 000 мс × 8 символов / 720 кредитов = 960 000 мс.
    expect(chunkSizeFor({ creditsPerMin: 8 })).toBe(8);
    expect(pollIntervalMs({ creditsPerMin: 8, creditsPerDay: 800 })).toBe(960_000);
  });

  it('любой разумный порог свежести делает free-тариф протухшим по построению', () => {
    // Тест-растяжка: 16 минут между опросами и порог свежести в минутах
    // несовместимы. Тот, кто включит Twelve Data на free и удивится
    // прочеркам, увидит здесь, что это свойство тарифа, а не дефект.
    expect(pollIntervalMs({ creditsPerMin: 8, creditsPerDay: 800 })).toBeGreaterThan(60_000);
  });

  it('PRO-ключ ускоряет поллер сам, без правки кода', () => {
    const pro = pollIntervalMs({ creditsPerMin: 60, creditsPerDay: 100_000 });
    expect(pro).toBeLessThan(pollIntervalMs({ creditsPerMin: 8, creditsPerDay: 800 }));
    // Минутный пол остаётся: быстрее минуты не ходим даже на богатом тарифе.
    expect(pro).toBeGreaterThanOrEqual(60_000);
  });

  it('чанк не больше минутного лимита: одним запросом в него не упираемся', () => {
    expect(chunkSizeFor({ creditsPerMin: 1 })).toBe(1);
    expect(chunkSizeFor({ creditsPerMin: 0 })).toBe(1);
  });
});

describe('ответы провайдера', () => {
  it('нормальный батч доходит до потребителя с провенансом', async () => {
    withResponses({
      'EUR/USD': { close: '1.08543', percent_change: '-0.25', timestamp: 1784990000 },
      'GBP/USD': { close: '1.27', percent_change: '0.1', timestamp: 1784990000 },
    });
    const { p, quotes } = provider();
    await p.pollOnce();
    expect(quotes.map((q) => q.symbol)).toEqual(['EURUSD', 'GBPUSD']);
    expect(quotes[0]).toMatchObject({ price: 1.08543, source: 'twelvedata', ts: 1784990000000 });
  });

  it('символ, отвергнутый тарифом, уходит в чёрный список и исчезает из вселенной', async () => {
    withResponses({
      'EUR/USD': { close: '1.08', percent_change: '0', timestamp: 1784990000 },
      'GBP/USD': { code: 403, message: 'not in your plan' },
    });
    const { p, quotes } = provider();
    await p.pollOnce();
    expect(quotes.map((q) => q.symbol)).toEqual(['EURUSD']);
    // Отвергнутый назван, а не просто молчит: потребитель видит, чего нет.
    expect(p.rejectedSymbols).toEqual(['GBPUSD']);
  });

  it('top-level 429 не двигает чанк и не выдумывает котировок', async () => {
    withResponses({ code: 429, message: 'limit' });
    const { p, quotes } = provider();
    await p.pollOnce();
    expect(quotes).toEqual([]);
    expect(p.status).toBe('reconnecting');
  });

  it('отказ сети не превращается в цену: котировок нет, статус назван', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const { p, quotes } = provider();
    await p.pollOnce();
    expect(quotes).toEqual([]);
    expect(p.status).toBe('reconnecting');
    expect(p.lastTickAt).toBe(0);
  });

  it('без ключа или без инструментов опрос не начинается вовсе', async () => {
    const calls = withResponses({});
    const { p } = provider({ apiKey: '' });
    p.connect();
    const { p: empty } = provider({}, []);
    empty.connect();
    expect(calls).toEqual([]);
  });
});

describe('normalizeTwelveQuote · успешный разбор ≠ пригодное значение', () => {
  it('строка "NaN" не становится ценой', () => {
    expect(normalizeTwelveQuote({ close: 'NaN' }, EURUSD, 'twelvedata')).toBeNull();
  });

  it('отсутствующая цена — отказ, а не ноль', () => {
    expect(normalizeTwelveQuote({}, EURUSD, 'twelvedata')).toBeNull();
  });

  it('отсутствующий percent_change → 0, и это осознанно: он не цена', () => {
    // Умолчание в проценте изменения — косметика; умолчание в цене — авария.
    // Разница названа здесь, чтобы следующий не «исправил» её единообразия ради.
    expect(normalizeTwelveQuote({ close: '1.1' }, EURUSD, 'twelvedata')?.changePercent).toBe(0);
  });

  it('без timestamp берётся наше время, а не ноль', () => {
    // ts = 0 у потребителя означает «котировки нет» (§5г): подставить его
    // значило бы объявить живую цену отсутствующей.
    const quote = normalizeTwelveQuote({ close: '1.1' }, EURUSD, 'twelvedata');
    expect(quote?.ts).toBeGreaterThan(1_700_000_000_000);
  });
});

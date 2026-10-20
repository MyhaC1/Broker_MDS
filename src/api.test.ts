import { describe, expect, it } from 'vitest';
import { buildHealth, buildQuotes, type HealthInput, type QuotesRouting } from './api.js';
import type { SnapshotResult } from './hub.js';
import type { RouteReason } from './registry.js';

/**
 * `/health` и `/v1/quotes`. Здесь живёт вторая половина B-003: ручка судила
 * о провайдере по открытому сокету при том, что возраст последнего тика у неё
 * уже был. Индикатор обязан гореть от того, что он называет.
 */

const NOW = 1_800_000_000_000;

function health(over: Partial<HealthInput> = {}) {
  return buildHealth({
    ages: [{ symbol: 'BTCUSD', ageMs: 800 }],
    providers: [{ name: 'binance', lastTickAt: NOW - 800 }],
    providerOf: new Map([
      ['BTCUSD', 'binance'],
      ['ETHUSD', 'binance'],
      ['EURUSD', 'twelvedata'],
    ]),
    primaryProvider: 'binance',
    staleAfterMs: 10_000,
    catalog: { source: 'binance-exchange-info', instruments: 484 },
    registry: {
      origin: 'file',
      version: 3,
      providers: [{ id: 'binance', enabled: true, silent: false }],
      routed: 484,
      checked: 484,
      missingKeys: [],
    },
    clients: 0,
    startedAt: NOW - 60_000,
    now: NOW,
    ...over,
  });
}

describe('/health · судит по возрасту данных, а не по сокету (B-003)', () => {
  it('данные свежие → 200 ok', () => {
    const { httpStatus, body } = health();
    expect(httpStatus).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.reason).toBeUndefined();
    expect(body.providers[0]?.fresh).toBe(1);
  });

  it('живой сокет, тиков нет 130 с → 503 degraded с названной причиной', () => {
    // Ровно то состояние, в котором дефект жил: сокет открыт, снапшот есть,
    // ему две минуты. Раньше ручка отдавала здесь 200 ok / connected.
    const { httpStatus, body } = health({
      ages: [{ symbol: 'BTCUSD', ageMs: 130_000 }],
      providers: [{ name: 'binance', lastTickAt: NOW - 130_000 }],
    });
    expect(httpStatus).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.reason).toContain('свежее');
    expect(body.providers[0]?.fresh).toBe(0);
    expect(body.providers[0]?.stale).toBe(1);
    expect(body.providers[0]?.lastTickAgeMs).toBe(130_000);
    expect(body.providers[0]?.oldestQuoteAgeMs).toBe(130_000);
  });

  it('состояние сокета наружу не отдаётся вовсе', () => {
    // Поле, способное соврать, хуже отсутствующего: один раз принятое за
    // признак жизни, оно будет принято снова. Проверяем весь JSON, а не
    // только форму объекта провайдера.
    const { body } = health();
    const json = JSON.stringify(body);
    expect(json).not.toContain('connected');
    expect(json).not.toContain('connecting');
    expect(json).not.toContain('reconnecting');
    expect(Object.keys(body.providers[0]!)).not.toContain('status');
  });

  it('тиков не было ни одного → lastTickAgeMs = null, а не гигантское число', () => {
    const { body } = health({
      ages: [],
      providers: [{ name: 'binance', lastTickAt: 0 }],
    });
    expect(body.providers[0]?.lastTickAgeMs).toBeNull();
    expect(body.status).toBe('degraded');
  });
});

describe('/health · порог свежести не задан', () => {
  it('503 и «свежесть не проверялась» — невыполненная проверка не выдаётся за пройденную', () => {
    const { httpStatus, body } = health({ staleAfterMs: null });
    expect(httpStatus).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.reason).toContain('QUOTE_STALE_AFTER_MS');
    // Не 0 и не «всё свежо» — счётчики честно говорят «не считали».
    expect(body.quotes.fresh).toBeNull();
    expect(body.providers[0]?.fresh).toBeNull();
    expect(body.providers[0]?.stale).toBeNull();
    // Охват при этом объявлен: в памяти был один символ.
    expect(body.quotes.total).toBe(1);
    expect(body.providers[0]?.quoted).toBe(1);
  });
});

describe('/health · разбивка по провайдерам', () => {
  it('молчание Twelve Data не делает сервис нездоровым (это поллер)', () => {
    const { httpStatus, body } = health({
      ages: [
        { symbol: 'BTCUSD', ageMs: 800 },
        { symbol: 'EURUSD', ageMs: 900_000 },
      ],
      providers: [
        { name: 'binance', lastTickAt: NOW - 800 },
        { name: 'twelvedata', lastTickAt: NOW - 900_000 },
      ],
    });
    expect(httpStatus).toBe(200);
    expect(body.status).toBe('ok');
    const twelve = body.providers.find((p) => p.name === 'twelvedata');
    // Но его протухание при этом ВИДНО, а не замазано.
    expect(twelve?.fresh).toBe(0);
    expect(twelve?.stale).toBe(1);
    expect(twelve?.oldestQuoteAgeMs).toBe(900_000);
  });

  it('возраст относится к тому провайдеру, чей символ, а не сваливается в кучу', () => {
    const { body } = health({
      ages: [
        { symbol: 'BTCUSD', ageMs: 500 },
        { symbol: 'ETHUSD', ageMs: 130_000 },
        { symbol: 'EURUSD', ageMs: 500 },
      ],
      providers: [
        { name: 'binance', lastTickAt: NOW - 500 },
        { name: 'twelvedata', lastTickAt: NOW - 500 },
      ],
    });
    const binance = body.providers.find((p) => p.name === 'binance')!;
    expect(binance.quoted).toBe(2);
    expect(binance.fresh).toBe(1);
    expect(binance.stale).toBe(1);
    expect(body.providers.find((p) => p.name === 'twelvedata')?.quoted).toBe(1);
    expect(body.quotes.total).toBe(3);
    expect(body.quotes.fresh).toBe(2);
  });

  it('основной провайдер вообще не подключён → degraded с названной причиной', () => {
    const { httpStatus, body } = health({ providers: [{ name: 'twelvedata', lastTickAt: NOW }] });
    expect(httpStatus).toBe(503);
    expect(body.reason).toContain('binance');
  });
});

describe('/v1/quotes · тело ответа', () => {
  const snap: SnapshotResult = {
    items: [
      {
        symbol: 'BTCUSD',
        name: 'Bitcoin',
        category: 'crypto',
        price: 70_000,
        digits: 0,
        changePercent: 1,
        ts: NOW,
        source: 'binance',
      },
    ],
    staleSymbols: ['ETHUSD'],
    checked: 2,
    missing: [],
  };

  const routing = (
    pairs: [string, RouteReason][] = [
      ['BTCUSD', 'primary'],
      ['ETHUSD', 'primary'],
    ],
  ): QuotesRouting => ({ readable: true, reasons: new Map(pairs) });

  it('порог, по которому решено, стоит в ответе рядом со списком', () => {
    const body = buildQuotes(snap, 10_000, routing(), ['BTCUSD', 'ETHUSD']);
    expect(body.staleAfterMs).toBe(10_000);
    expect(body.staleSymbols).toEqual(['ETHUSD']);
    expect(body.checked).toBe(2);
    expect(body.items).toHaveLength(1);
    expect(body.reason).toBeUndefined();
  });

  it('порога нет → staleSymbols null и причина названа, а не пустой список', () => {
    const body = buildQuotes({ items: [], staleSymbols: null, checked: 2, missing: [] }, null, routing(), [
      'BTCUSD',
      'ETHUSD',
    ]);
    expect(body.staleAfterMs).toBeNull();
    expect(body.staleSymbols).toBeNull();
    expect(body.reason).toContain('QUOTE_STALE_AFTER_MS');
    // Потребитель обязан отличить «MDS считает всё свежим» от «не считает».
    expect(body.checked).toBe(2);
  });
});

/**
 * Причина недоступности по каждому символу (Р-047). До реестра все эти
 * случаи выглядели снаружи одинаково — символа просто нет в `items`, и
 * «источник выключили» читалось так же, как «пока не приехало».
 */
describe('/v1/quotes · почему символа нет — разные ответы, а не один', () => {
  function reasonFor(route: RouteReason | null, requested = 'X') {
    const reasons = new Map<string, RouteReason>();
    if (route) reasons.set(requested, route);
    const body = buildQuotes(
      { items: [], staleSymbols: [], checked: 0, missing: [requested] },
      10_000,
      { readable: true, reasons },
      [requested],
    );
    return body.unavailable.find((u) => u.symbol === requested)?.reason;
  }

  it('источник выключен оператором → source-disabled, а не «нет данных»', () => {
    expect(reasonFor('source-disabled')).toBe('source-disabled');
  });

  it('источника для символа нет в реестре → no-source', () => {
    expect(reasonFor('no-source')).toBe('no-source');
  });

  it('источник назначен, но цены ещё нет → source-silent', () => {
    expect(reasonFor('primary')).toBe('source-silent');
    expect(reasonFor('failover')).toBe('source-silent');
    expect(reasonFor('silent')).toBe('source-silent');
  });

  it('символа нет во вселенной вовсе → not-in-catalog, а не «источник молчит»', () => {
    expect(reasonFor(null)).toBe('not-in-catalog');
  });

  it('цена есть, но старая → stale, и она не смешивается с «источник молчит»', () => {
    const body = buildQuotes(
      { items: [], staleSymbols: ['ETHUSD'], checked: 1, missing: [] },
      10_000,
      { readable: true, reasons: new Map<string, RouteReason>([['ETHUSD', 'primary']]) },
      ['ETHUSD'],
    );
    expect(body.unavailable).toEqual([{ symbol: 'ETHUSD', reason: 'stale' }]);
  });

  it('порога нет → threshold-unset у каждого спрошенного, а не молчание', () => {
    const body = buildQuotes(
      { items: [], staleSymbols: null, checked: 0, missing: ['BTCUSD'] },
      null,
      { readable: true, reasons: new Map<string, RouteReason>([['BTCUSD', 'primary']]) },
      ['BTCUSD'],
    );
    expect(body.unavailable).toEqual([{ symbol: 'BTCUSD', reason: 'threshold-unset' }]);
  });

  it('реестр не прочитан → registry-unreadable у всех, а не пустой ответ', () => {
    const body = buildQuotes(
      { items: [], staleSymbols: null, checked: 0, missing: ['BTCUSD'] },
      10_000,
      { readable: false, reasons: new Map() },
      ['BTCUSD', 'ETHUSD'],
    );
    expect(body.unavailable).toEqual([
      { symbol: 'BTCUSD', reason: 'registry-unreadable' },
      { symbol: 'ETHUSD', reason: 'registry-unreadable' },
    ]);
    expect(body.reason).toContain('реестр');
  });

  it('спросили всю вселенную — отвечаем про всю вселенную, а не про найденное', () => {
    const body = buildQuotes(
      { items: [], staleSymbols: [], checked: 0, missing: [] },
      10_000,
      {
        readable: true,
        reasons: new Map<string, RouteReason>([
          ['BTCUSD', 'primary'],
          ['XAUUSD', 'source-disabled'],
        ]),
      },
      null,
    );
    expect(body.unavailable).toEqual([
      { symbol: 'BTCUSD', reason: 'source-silent' },
      { symbol: 'XAUUSD', reason: 'source-disabled' },
    ]);
  });
});

/**
 * Три состояния реестра, которые нельзя сливать в одно: не прочитан, пуст,
 * всё выключено. Чинятся по-разному — значит и называться обязаны
 * по-разному.
 */
describe('/health · состояние реестра провайдеров', () => {
  it('реестр не прочитан → 503, и это первая причина, раньше порога свежести', () => {
    const { httpStatus, body } = health({
      staleAfterMs: null,
      registry: {
        origin: 'error',
        error: 'JSON: Unexpected token',
        version: null,
        providers: [],
        routed: 0,
        checked: 0,
        missingKeys: [],
      },
    });
    expect(httpStatus).toBe(503);
    expect(body.reason).toContain('не прочитан');
    // Порог тоже не задан, но первой строкой стоит более блокирующая причина.
    expect(body.reason).not.toContain('QUOTE_STALE_AFTER_MS');
  });

  it('пустой реестр ≠ выключенный источник — это разные причины', () => {
    const empty = health({
      registry: { origin: 'file', version: 1, providers: [], routed: 0, checked: 0, missingKeys: [] },
    });
    const disabled = health({
      registry: {
        origin: 'file',
        version: 1,
        providers: [{ id: 'binance', enabled: false, silent: false }],
        routed: 0,
        checked: 484,
        missingKeys: [],
      },
    });
    expect(empty.body.reason).toContain('пуст');
    expect(disabled.body.reason).toContain('включённого');
    expect(empty.body.reason).not.toBe(disabled.body.reason);
  });

  it('включён источник без ключа → названо отдельно, а не «молчит»', () => {
    const { httpStatus, body } = health({
      registry: {
        origin: 'file',
        version: 2,
        providers: [{ id: 'twelvedata', enabled: true, silent: true }],
        routed: 17,
        checked: 484,
        missingKeys: ['twelvedata'],
      },
    });
    expect(httpStatus).toBe(503);
    expect(body.reason).toContain('без ключа');
    expect(body.reason).toContain('twelvedata');
  });

  it('встроенное умолчание называет себя умолчанием в самом ответе', () => {
    const { body } = health({
      registry: {
        origin: 'builtin-default',
        version: 0,
        providers: [{ id: 'binance', enabled: true, silent: false }],
        routed: 484,
        checked: 484,
        missingKeys: [],
      },
    });
    expect(body.registry.origin).toBe('builtin-default');
  });
});

import { describe, expect, it } from 'vitest';
import { buildHealth, buildQuotes, type HealthInput } from './api.js';
import type { SnapshotResult } from './hub.js';

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
    catalog: { source: 'binance-exchangeInfo', instruments: 484 },
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
      },
    ],
    staleSymbols: ['ETHUSD'],
    checked: 2,
  };

  it('порог, по которому решено, стоит в ответе рядом со списком', () => {
    const body = buildQuotes(snap, 10_000);
    expect(body.staleAfterMs).toBe(10_000);
    expect(body.staleSymbols).toEqual(['ETHUSD']);
    expect(body.checked).toBe(2);
    expect(body.items).toHaveLength(1);
    expect(body.reason).toBeUndefined();
  });

  it('порога нет → staleSymbols null и причина названа, а не пустой список', () => {
    const body = buildQuotes({ items: [], staleSymbols: null, checked: 2 }, null);
    expect(body.staleAfterMs).toBeNull();
    expect(body.staleSymbols).toBeNull();
    expect(body.reason).toContain('QUOTE_STALE_AFTER_MS');
    // Потребитель обязан отличить «MDS считает всё свежим» от «не считает».
    expect(body.checked).toBe(2);
  });
});

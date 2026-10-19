import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { BinanceProvider, normalizeTick } from './binance.js';
import type { CatalogInstrument, Quote } from '../types.js';

/**
 * Провайдер Binance против **поддельного источника** (MDS-04).
 *
 * Починка, проверенная только чтением кода, не проверена: отказ, который
 * умеет воспроизводить только природа, здесь воспроизводится своим сервером.
 * Так и был пойман half-open (B-003) — соединение целое, кадров нет.
 *
 * Уборка висит на `afterEach`, а не в конце тела теста: упавшая проверка
 * иначе оставляет сокет и таймер живыми, и прогон **зависает вместо того,
 * чтобы покраснеть**. Зависание списывают на «что-то долго».
 */

function instrument(symbol: string, providerSymbol: string): CatalogInstrument {
  return {
    symbol,
    name: symbol,
    category: 'crypto',
    segment: null,
    digits: 2,
    provider: 'binance',
    providerSymbol,
  };
}

const UNIVERSE = [instrument('BTCUSD', 'btcusdt'), instrument('ETHUSD', 'ethusdt')];

interface Fake {
  url: string;
  /** Сообщения, пришедшие от провайдера (SUBSCRIBE/UNSUBSCRIBE). */
  received: { method: string; params: string[] }[];
  /** Сколько раз к нам подключались: реконнект виден отсюда, а не из логов. */
  connections: number;
  send(payload: unknown): void;
  close(): Promise<void>;
}

const fakes: Fake[] = [];
const providers: BinanceProvider[] = [];

afterEach(async () => {
  for (const p of providers.splice(0)) p.stop();
  for (const f of fakes.splice(0)) await f.close();
});

async function fakeBinance(options: { autoRespond?: boolean } = {}): Promise<Fake> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  const sockets = new Set<ServerSocket>();
  const fake: Fake = {
    url: `ws://127.0.0.1:${port}`,
    received: [],
    connections: 0,
    send(payload) {
      for (const s of sockets) s.send(JSON.stringify(payload));
    },
    async close() {
      for (const s of sockets) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  wss.on('connection', (socket) => {
    fake.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const parsed = JSON.parse(String(raw)) as { method: string; params: string[]; id: number };
      fake.received.push({ method: parsed.method, params: parsed.params });
      // Ack подписки — ровно тот кадр, который НЕ должен считаться жизнью.
      if (options.autoRespond !== false) socket.send(JSON.stringify({ result: null, id: parsed.id }));
    });
  });
  fakes.push(fake);
  return fake;
}

function start(fake: Fake, options: { silenceMs?: number; id?: string } = {}) {
  const quotes: Quote[] = [];
  const provider = new BinanceProvider((q) => quotes.push(q), {
    wsUrl: fake.url,
    silenceMs: options.silenceMs ?? 60_000,
    id: options.id ?? 'binance',
  });
  providers.push(provider);
  provider.setInstruments(UNIVERSE);
  provider.connect();
  return { provider, quotes };
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('условие не наступило за отведённое время');
}

function ticker(symbol: string, price: string, at = Date.now()) {
  return { e: '24hrTicker', E: at, s: symbol, c: price, P: '1.5' };
}

describe('BinanceProvider · живой поддельный источник', () => {
  it('подписывается на пары вселенной и доносит тик до потребителя', async () => {
    const fake = await fakeBinance();
    const { quotes } = start(fake);
    await until(() => fake.received.length > 0);
    expect(fake.received[0]).toEqual({ method: 'SUBSCRIBE', params: ['btcusdt@ticker', 'ethusdt@ticker'] });

    fake.send(ticker('BTCUSDT', '64034.52'));
    await until(() => quotes.length > 0);
    expect(quotes[0]).toMatchObject({ symbol: 'BTCUSD', price: 64034.52, source: 'binance' });
  });

  it('провенанс берётся из реестра: id источника едет в каждом тике', async () => {
    const fake = await fakeBinance();
    const { quotes } = start(fake, { id: 'binance-eu' });
    await until(() => fake.received.length > 0);
    fake.send(ticker('BTCUSDT', '1'));
    await until(() => quotes.length > 0);
    expect(quotes[0]?.source).toBe('binance-eu');
  });

  it('мусорный кадр и чужой символ не роняют и не попадают в котировки', async () => {
    const fake = await fakeBinance();
    const { quotes } = start(fake);
    await until(() => fake.received.length > 0);
    fake.send({ это: 'не тикер' });
    fake.send(ticker('PEPEUSDT', '1'));
    fake.send(ticker('BTCUSDT', 'не-число'));
    fake.send(ticker('ETHUSDT', '3000'));
    await until(() => quotes.length > 0);
    expect(quotes.map((q) => q.symbol)).toEqual(['ETHUSD']);
  });
});

describe('BinanceProvider · half-open: сокет цел, кадров нет (B-003)', () => {
  it('тишина дольше порога → соединение признано мёртвым и переподключение', async () => {
    // Состояние, в котором дефект жил: сервер принял соединение и молчит.
    // `close` не придёт никогда, поэтому реконнект по событию не сработает.
    const fake = await fakeBinance({ autoRespond: false });
    const { provider } = start(fake, { silenceMs: 600 });
    await until(() => fake.connections === 1);
    await until(() => provider.silenceReconnects >= 1);
    // Связь меряется на стороне того, с кем связываются: второе подключение
    // видно поддельному серверу, а не нашему логу.
    await until(() => fake.connections >= 2);
  });

  it('ack подписки жизнью не считается: он кадр, но не котировка', async () => {
    // Живость отмечается на принятом и ОПОЗНАННОМ сообщении. Сервер исправно
    // отвечает ack на подписку — если бы он продлевал жизнь, таймер тишины
    // не сработал бы никогда и half-open вернулся бы незамеченным.
    const fake = await fakeBinance({ autoRespond: true });
    const { provider } = start(fake, { silenceMs: 600 });
    await until(() => fake.received.length > 0);
    await until(() => provider.silenceReconnects >= 1);
  });

  it('тики идут → тишины нет и переподключений нет', async () => {
    const fake = await fakeBinance();
    const { provider, quotes } = start(fake, { silenceMs: 900 });
    await until(() => fake.received.length > 0);
    const pump = setInterval(() => fake.send(ticker('BTCUSDT', '70000')), 100);
    try {
      await new Promise((r) => setTimeout(r, 1_500));
    } finally {
      clearInterval(pump);
    }
    expect(provider.silenceReconnects).toBe(0);
    expect(quotes.length).toBeGreaterThan(5);
  });
});

describe('BinanceProvider · переназначение набора на живом сокете (Р-047)', () => {
  it('смена набора шлёт дельту, а не переподключается', async () => {
    const fake = await fakeBinance();
    const { provider } = start(fake);
    await until(() => fake.received.length === 1);

    provider.setInstruments([UNIVERSE[0]!, instrument('SOLUSD', 'solusdt')]);
    await until(() => fake.received.length >= 3);
    const methods = fake.received.map((m) => `${m.method}:${m.params.join(',')}`);
    expect(methods).toContain('UNSUBSCRIBE:ethusdt@ticker');
    expect(methods).toContain('SUBSCRIBE:solusdt@ticker');
    // Переподключения не было: оно уронило бы и те символы, которых правка
    // не касалась.
    expect(fake.connections).toBe(1);
  });

  it('снятый символ перестаёт давать котировки, даже если источник его шлёт', async () => {
    const fake = await fakeBinance();
    const { provider, quotes } = start(fake);
    await until(() => fake.received.length === 1);
    provider.setInstruments([UNIVERSE[0]!]);
    await until(() => fake.received.length >= 2);

    fake.send(ticker('ETHUSDT', '3000'));
    fake.send(ticker('BTCUSDT', '70000'));
    await until(() => quotes.length > 0);
    expect(quotes.map((q) => q.symbol)).toEqual(['BTCUSD']);
  });

  it('одинаковый набор дельты не шлёт: лишних сообщений нет', async () => {
    const fake = await fakeBinance();
    const { provider } = start(fake);
    await until(() => fake.received.length === 1);
    provider.setInstruments([...UNIVERSE]);
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.received).toHaveLength(1);
  });
});

describe('normalizeTick · разбор и приведение — разные барьеры', () => {
  const bySymbol = new Map(UNIVERSE.map((i) => [i.providerSymbol, i]));

  it('строка "NaN" разбирается успешно, но пригодным значением не является', () => {
    // Успешный разбор не означает пригодного значения: это ещё один путь к
    // цене ноль мимо проверок «это вообще число?».
    expect(normalizeTick(ticker('BTCUSDT', 'NaN'), bySymbol, 'binance')).toBeNull();
  });

  it('бесконечность отбрасывается, а не становится ценой', () => {
    expect(normalizeTick(ticker('BTCUSDT', 'Infinity'), bySymbol, 'binance')).toBeNull();
  });

  it('нулевая цена от источника проходит — это не наш домысел, а его данные', () => {
    // Намеренно: подменять отказом настоящий ноль источника мы не вправе.
    // Мутацию «запретить ноль» писать не надо, она изменила бы смысл.
    expect(normalizeTick(ticker('BTCUSDT', '0'), bySymbol, 'binance')?.price).toBe(0);
  });
});

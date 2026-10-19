import WebSocket from 'ws';
import { config } from '../config.js';
import type { CatalogInstrument, Quote } from '../types.js';

/**
 * Провайдер Binance: raw-сокет /ws + SUBSCRIBE на `<symbol>@ticker` по
 * всем парам вселенной (24h-статистика: lastPrice + priceChangePercent).
 * Публичные данные, ключ не нужен. Лимит Binance — 1024 стрима на
 * соединение; подписку шлём чанками по 500 (и ≤5 сообщений/сек).
 * Всеобщий `!ticker@arr` не используем — в нашей сети он не отдаёт кадров.
 * Reconnect с backoff; разрыв каждые 24ч у Binance штатный.
 *
 * **Реконнект стоит на двух ногах, и вторая обязательна (B-003).** События
 * `close`/`error` ловят разрыв, о котором нам сообщили. При half-open TCP
 * никто ничего не сообщает: сокет открыт, данных нет, `close` не придёт
 * никогда. Отсутствие события не является событием — поэтому есть ещё и
 * таймер тишины: нет опознанного тика `silenceMs` — соединение считается
 * мёртвым независимо от того, что о себе думает сокет.
 */

// Лимит Binance на размер одного WS-сообщения (~8 КБ → «Payload too long»):
// держим чанк маленьким. Плюс лимит 5 сообщений/сек — шлём с задержкой.
const MAX_STREAMS_PER_MSG = 100;
const SUBSCRIBE_STAGGER_MS = 300;

interface BinanceTicker {
  e: string; // "24hrTicker"
  E: number; // event time ms
  s: string; // "BTCUSDT"
  c: string; // last price
  P: string; // price change percent
}

export type ProviderStatus = 'connecting' | 'connected' | 'reconnecting';

export interface BinanceProviderOptions {
  /** Адрес WS. Вынесен в опции, чтобы тест мог поднять поддельного провайдера. */
  wsUrl: string;
  /** Таймер тишины, мс: столько без опознанного тика — соединение мёртвое. */
  silenceMs: number;
  /** id источника из реестра провайдеров: уходит в `Quote.source` (Р-047). */
  id: string;
}

export function normalizeTick(
  data: BinanceTicker,
  bySymbol: Map<string, CatalogInstrument>,
  sourceId: string,
): Quote | null {
  const instrument = bySymbol.get(data.s.toLowerCase());
  if (!instrument) return null;
  const price = Number.parseFloat(data.c);
  const changePercent = Number.parseFloat(data.P);
  if (!Number.isFinite(price) || !Number.isFinite(changePercent)) return null;
  return {
    symbol: instrument.symbol,
    name: instrument.name,
    category: instrument.category,
    price,
    digits: instrument.digits,
    changePercent,
    ts: data.E,
    source: sourceId,
  };
}

export class BinanceProvider {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUs = false;
  private instruments: CatalogInstrument[] = [];
  private bySymbol = new Map<string, CatalogInstrument>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly wsUrl: string;
  private readonly silenceMs: number;
  readonly id: string;
  /** Что уже подписано на текущем сокете: база для дельты при переназначении. */
  private subscribed = new Set<string>();
  /**
   * Момент последнего **признака жизни соединения**: открытие сокета либо
   * опознанный тик. Отдельно от `lastTickAt`, потому что до первого тика
   * `lastTickAt = 0`, и таймер тишины срывался бы в реконнект сразу же.
   */
  private lastSignalAt = 0;
  status: ProviderStatus = 'connecting';
  lastTickAt = 0;
  /** Сколько раз соединение было признано мёртвым по тишине. Для /health и тестов. */
  silenceReconnects = 0;

  constructor(
    private readonly onQuote: (q: Quote) => void,
    options?: Partial<BinanceProviderOptions>,
  ) {
    this.wsUrl = options?.wsUrl ?? config.binanceWsUrl;
    this.silenceMs = options?.silenceMs ?? config.providerSilenceMs;
    this.id = options?.id ?? 'binance';
  }

  /**
   * Пары, которые источник обязан транслировать. Зовётся и при старте, и при
   * каждой смене маршрутизации (Р-047): переключение провайдера обязано
   * доходить до живого сокета, а не только до таблицы в памяти.
   *
   * На открытом сокете шлём **дельту**, а не переподключаемся: переподключение
   * ради смены набора уронило бы и те символы, которых правка не касалась.
   */
  setInstruments(instruments: CatalogInstrument[]) {
    this.instruments = instruments;
    this.bySymbol = new Map(instruments.map((i) => [i.providerSymbol, i]));
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) this.applyDelta(ws);
  }

  /** Разница между подписанным и нужным, чанками и с уважением к лимитам. */
  private applyDelta(ws: WebSocket) {
    const wanted = new Set(this.instruments.map((i) => i.providerSymbol));
    const toAdd = [...wanted].filter((s) => !this.subscribed.has(s));
    const toDrop = [...this.subscribed].filter((s) => !wanted.has(s));
    if (toAdd.length === 0 && toDrop.length === 0) return;
    this.send(ws, 'UNSUBSCRIBE', toDrop);
    this.send(ws, 'SUBSCRIBE', toAdd);
    this.subscribed = wanted;
    console.info(
      `[${this.id}] переназначение: +${toAdd.length} / −${toDrop.length} пар, итого ${wanted.size}`,
    );
  }

  private send(ws: WebSocket, method: 'SUBSCRIBE' | 'UNSUBSCRIBE', symbols: string[]) {
    const streams = symbols.map((s) => `${s}@ticker`);
    for (let n = 0, id = 1; n < streams.length; n += MAX_STREAMS_PER_MSG, id += 1) {
      const params = streams.slice(n, n + MAX_STREAMS_PER_MSG);
      const idx = n / MAX_STREAMS_PER_MSG;
      const t = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method, params, id }));
      }, idx * SUBSCRIBE_STAGGER_MS);
      t.unref?.();
    }
  }

  /**
   * Подписка на @ticker всех пар вселенной: чанки по 100 (иначе Binance
   * рвёт «Payload too long») с задержкой (лимит 5 сообщений/сек).
   * Лимит 1024 стрима на соединение — при большем нужен шардинг по сокетам.
   */
  private subscribe(ws: WebSocket) {
    if (this.instruments.length > 1024) {
      console.warn(
        `[binance] ${this.instruments.length} пар > лимит 1024/соединение — нужен шардинг по сокетам`,
      );
    }
    const symbols = this.instruments.map((i) => i.providerSymbol);
    this.send(ws, 'SUBSCRIBE', symbols);
    this.subscribed = new Set(symbols);
  }

  private stopWatchdog() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /**
   * Таймер тишины. Тикает чаще порога, иначе фактическое обнаружение
   * растягивается вдвое. `terminate()`, а не `close()`: закрытие с
   * рукопожатием ждёт ответа той стороны, а её как раз и нет — на half-open
   * `close()` может висеть до системного таймаута TCP.
   */
  private startWatchdog(ws: WebSocket) {
    this.stopWatchdog();
    const tick = Math.max(200, Math.floor(this.silenceMs / 3));
    this.watchdog = setInterval(() => {
      if (this.ws !== ws) return;
      const silentFor = Date.now() - this.lastSignalAt;
      if (silentFor <= this.silenceMs) return;
      this.silenceReconnects += 1;
      this.stopWatchdog();
      this.status = 'reconnecting';
      console.warn(
        `[binance] тишина ${silentFor}мс > ${this.silenceMs}мс при открытом сокете — соединение считаем мёртвым (B-003)`,
      );
      ws.terminate();
    }, tick);
    this.watchdog.unref?.();
  }

  connect() {
    this.stopWatchdog();
    this.status = this.attempts === 0 ? 'connecting' : 'reconnecting';
    const ws = new WebSocket(`${this.wsUrl}/ws`);
    this.ws = ws;

    ws.on('open', () => {
      this.attempts = 0;
      this.status = 'connected';
      // Отсчёт тишины начинается от открытия, а не от нулевого lastTickAt.
      this.lastSignalAt = Date.now();
      this.startWatchdog(ws);
      this.subscribe(ws);
      console.info(`[binance] connected: подписка на ${this.instruments.length} пар @ticker`);
    });

    ws.on('message', (raw) => {
      try {
        // Кадр — либо ack подписки ({result,id}), либо тикер 24hrTicker
        const ticker = JSON.parse(String(raw)) as BinanceTicker;
        if (ticker.e !== '24hrTicker') return;
        const quote = normalizeTick(ticker, this.bySymbol, this.id);
        if (quote) {
          // Живость отмечается на ПРИНЯТОМ И ОПОЗНАННОМ сообщении, а не на
          // любом кадре: иначе ack подписки или мусор продлевали бы жизнь
          // соединению, по которому котировок нет.
          this.lastTickAt = Date.now();
          this.lastSignalAt = this.lastTickAt;
          this.onQuote(quote);
        }
      } catch {
        // мусорный кадр — игнор
      }
    });

    const scheduleRetry = () => {
      // Обработчик устаревшего сокета не должен плодить лишние реконнекты.
      if (this.ws !== ws) return;
      // Подписки живут на сокете: уцелевший список после разрыва заставил бы
      // дельту решить, что подписываться не на что.
      this.subscribed.clear();
      this.stopWatchdog();
      if (this.closedByUs) return;
      this.status = 'reconnecting';
      const delay = Math.min(1_000 * 2 ** this.attempts, 30_000);
      this.attempts += 1;
      console.warn(`[binance] reconnect in ${delay}ms (attempt ${this.attempts})`);
      const t = setTimeout(() => this.connect(), delay);
      t.unref?.();
    };

    ws.on('close', scheduleRetry);
    ws.on('error', (error) => {
      console.warn('[binance] ws error:', (error as Error).message);
      ws.terminate();
    });
  }

  /** Остановка провайдера (тесты, штатное завершение). */
  stop() {
    this.closedByUs = true;
    this.subscribed.clear();
    this.stopWatchdog();
    this.ws?.terminate();
    this.ws = null;
  }
}

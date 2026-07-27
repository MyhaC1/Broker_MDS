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

export function normalizeTick(
  data: BinanceTicker,
  bySymbol: Map<string, CatalogInstrument>,
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
  };
}

export class BinanceProvider {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUs = false;
  private instruments: CatalogInstrument[] = [];
  private bySymbol = new Map<string, CatalogInstrument>();
  status: ProviderStatus = 'connecting';
  lastTickAt = 0;

  constructor(private readonly onQuote: (q: Quote) => void) {}

  /** Пары вселенной; на них подписываемся при (пере)соединении. */
  setInstruments(instruments: CatalogInstrument[]) {
    this.instruments = instruments;
    this.bySymbol = new Map(instruments.map((i) => [i.providerSymbol, i]));
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
    const streams = this.instruments.map((i) => `${i.providerSymbol}@ticker`);
    const chunks: string[][] = [];
    for (let n = 0; n < streams.length; n += MAX_STREAMS_PER_MSG) {
      chunks.push(streams.slice(n, n + MAX_STREAMS_PER_MSG));
    }
    chunks.forEach((params, idx) => {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: idx + 1 }));
        }
      }, idx * SUBSCRIBE_STAGGER_MS).unref();
    });
  }

  connect() {
    this.status = this.attempts === 0 ? 'connecting' : 'reconnecting';
    const ws = new WebSocket(`${config.binanceWsUrl}/ws`);
    this.ws = ws;

    ws.on('open', () => {
      this.attempts = 0;
      this.status = 'connected';
      this.subscribe(ws);
      console.info(`[binance] connected: подписка на ${this.instruments.length} пар @ticker`);
    });

    ws.on('message', (raw) => {
      try {
        // Кадр — либо ack подписки ({result,id}), либо тикер 24hrTicker
        const ticker = JSON.parse(String(raw)) as BinanceTicker;
        if (ticker.e !== '24hrTicker') return;
        const quote = normalizeTick(ticker, this.bySymbol);
        if (quote) {
          this.lastTickAt = Date.now();
          this.onQuote(quote);
        }
      } catch {
        // мусорный кадр — игнор
      }
    });

    const scheduleRetry = () => {
      if (this.closedByUs) return;
      this.status = 'reconnecting';
      const delay = Math.min(1_000 * 2 ** this.attempts, 30_000);
      this.attempts += 1;
      console.warn(`[binance] reconnect in ${delay}ms (attempt ${this.attempts})`);
      setTimeout(() => this.connect(), delay).unref();
    };

    ws.on('close', scheduleRetry);
    ws.on('error', (error) => {
      console.warn('[binance] ws error:', (error as Error).message);
      ws.close();
    });
  }
}

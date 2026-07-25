import WebSocket from 'ws';
import { config } from '../config.js';
import type { CatalogInstrument, Quote } from '../types.js';

/**
 * Провайдер Binance: combined stream `<symbol>@ticker` (24h-статистика,
 * lastPrice + priceChangePercent). Публичные данные, ключ не нужен.
 * Reconnect с экспоненциальным backoff; Binance рвёт соединение каждые 24ч —
 * это штатно. Смена каталога → пересоединение с новым списком стримов.
 */

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

  setInstruments(instruments: CatalogInstrument[]) {
    const same =
      instruments.length === this.instruments.length &&
      instruments.every((i, n) => i.providerSymbol === this.instruments[n]?.providerSymbol);
    this.instruments = instruments;
    this.bySymbol = new Map(instruments.map((i) => [i.providerSymbol, i]));
    if (!same) this.reconnect();
  }

  private streamUrl(): string {
    const streams = this.instruments.map((i) => `${i.providerSymbol}@ticker`).join('/');
    return `${config.binanceWsUrl}/stream?streams=${streams}`;
  }

  private reconnect() {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
    this.closedByUs = false;
    this.connect();
  }

  connect() {
    if (this.instruments.length === 0) return;
    this.status = this.attempts === 0 ? 'connecting' : 'reconnecting';
    const ws = new WebSocket(this.streamUrl());
    this.ws = ws;

    ws.on('open', () => {
      this.attempts = 0;
      this.status = 'connected';
      console.info(`[binance] connected: ${this.instruments.length} streams`);
    });

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw)) as { data?: BinanceTicker };
        if (message.data?.e === '24hrTicker') {
          const quote = normalizeTick(message.data, this.bySymbol);
          if (quote) {
            this.lastTickAt = Date.now();
            this.onQuote(quote);
          }
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

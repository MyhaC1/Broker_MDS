import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import type { Quote } from './types.js';

/**
 * Fan-out хаб. Контракт — драйвер сайта (packages/realtime/drivers/socketio):
 *  client → 'subscribe' / 'unsubscribe' (string[] канонических символов)
 *  server → 'quotes:batch' (Quote[]), батч ~250 мс, только подписанное.
 * На subscribe сразу уходит снапшот — тикер рендерится без ожидания тика.
 */
export class QuoteHub {
  private readonly last = new Map<string, Quote>();
  private readonly io: Server;
  /** socket.id → { subscribed, dirty } */
  private readonly clients = new Map<string, { subscribed: Set<string>; dirty: Set<string> }>();

  constructor(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      transports: ['websocket', 'polling'],
    });

    this.io.on('connection', (socket) => {
      const state = { subscribed: new Set<string>(), dirty: new Set<string>() };
      this.clients.set(socket.id, state);

      socket.on('subscribe', (symbols: unknown) => {
        if (!Array.isArray(symbols)) return;
        const snapshot: Quote[] = [];
        for (const s of symbols) {
          if (typeof s !== 'string' || s.length > 20) continue;
          state.subscribed.add(s);
          const quote = this.last.get(s);
          if (quote) snapshot.push(quote);
        }
        if (snapshot.length) socket.emit('quotes:batch', snapshot);
      });

      socket.on('unsubscribe', (symbols: unknown) => {
        if (!Array.isArray(symbols)) return;
        for (const s of symbols) {
          state.subscribed.delete(String(s));
          state.dirty.delete(String(s));
        }
      });

      socket.on('disconnect', () => this.clients.delete(socket.id));
    });

    const flusher = setInterval(() => this.flush(), config.batchMs);
    flusher.unref();
  }

  /** Вход от провайдера: обновить снапшот и пометить dirty у подписчиков. */
  push(quote: Quote) {
    this.last.set(quote.symbol, quote);
    for (const state of this.clients.values()) {
      if (state.subscribed.has(quote.symbol)) state.dirty.add(quote.symbol);
    }
  }

  private flush() {
    for (const [id, state] of this.clients) {
      if (state.dirty.size === 0) continue;
      const batch: Quote[] = [];
      for (const symbol of state.dirty) {
        const quote = this.last.get(symbol);
        if (quote) batch.push(quote);
      }
      state.dirty.clear();
      if (batch.length) this.io.to(id).emit('quotes:batch', batch);
    }
  }

  snapshot(symbols?: string[]): Quote[] {
    if (!symbols || symbols.length === 0) return [...this.last.values()];
    return symbols.map((s) => this.last.get(s)).filter((q): q is Quote => Boolean(q));
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

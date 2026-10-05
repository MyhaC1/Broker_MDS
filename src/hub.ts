import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import type { Quote } from './types.js';

/**
 * Fan-out хаб. Контракт — драйвер сайта (packages/realtime/drivers/socketio):
 *  client → 'subscribe' / 'unsubscribe' (string[] канонических символов)
 *  server → 'quotes:batch' (Quote[]), батч ~250 мс, только подписанное.
 * На subscribe уходит снапшот — но **только свежая его часть** (B-003).
 *
 * Инвариант, который держит этот класс: **протухшая котировка не покидает
 * хаб ни по одному пути** — ни REST-снапшотом, ни снапшотом на subscribe, ни
 * живым батчем. Один общий фильтр `pick()` на все три пути: разные пути с
 * разными правилами и есть то, как дефект возвращается.
 */

/**
 * Результат снапшота. Три разных утверждения, склеивать нельзя:
 *  - `items`        — котировки, которые мы готовы назвать текущими;
 *  - `staleSymbols` — символы, у которых цена есть, но она старше порога.
 *                     `null` означает «не считали» (порога нет), пустой
 *                     массив — «считали, протухших не нашли». Пустой список
 *                     не означает «всё свежо» — КОНТРАКТЫ.md §5г.
 *  - `checked`      — сколько символов осмотрено: охват проверки, без него
 *                     «протухших нет» неотличимо от «проверять было нечего».
 */
export interface SnapshotResult {
  items: Quote[];
  staleSymbols: string[] | null;
  checked: number;
}

export interface HubOptions {
  /** Порог свежести, мс. `null` — порога нет, котировки не отдаются вовсе. */
  staleAfterMs: number | null;
  /** Инъекция времени — для тестов. */
  now: () => number;
}

export class QuoteHub {
  private readonly last = new Map<string, Quote>();
  private readonly io: Server;
  private readonly staleAfterMs: number | null;
  private readonly now: () => number;
  /** socket.id → { subscribed, dirty } */
  private readonly clients = new Map<string, { subscribed: Set<string>; dirty: Set<string> }>();

  constructor(httpServer: HttpServer, options?: Partial<HubOptions>) {
    this.staleAfterMs = options?.staleAfterMs !== undefined ? options.staleAfterMs : config.staleAfterMs;
    this.now = options?.now ?? Date.now;

    this.io = new Server(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      transports: ['websocket', 'polling'],
    });

    this.io.on('connection', (socket) => {
      const state = { subscribed: new Set<string>(), dirty: new Set<string>() };
      this.clients.set(socket.id, state);

      socket.on('subscribe', (symbols: unknown) => {
        if (!Array.isArray(symbols)) return;
        const wanted: string[] = [];
        for (const s of symbols) {
          if (typeof s !== 'string' || s.length > 20) continue;
          state.subscribed.add(s);
          wanted.push(s);
        }
        // Снапшот на subscribe шёл мимо любой проверки возраста — именно он
        // и рисовал потребителю двухминутную цену как текущую (B-003).
        const { items } = this.snapshot(wanted);
        if (items.length) socket.emit('quotes:batch', items);
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
    flusher.unref?.();
  }

  /** Вход от провайдера: обновить снапшот и пометить dirty у подписчиков. */
  push(quote: Quote) {
    this.last.set(quote.symbol, quote);
    for (const state of this.clients.values()) {
      if (state.subscribed.has(quote.symbol)) state.dirty.add(quote.symbol);
    }
  }

  /**
   * Единственное место, где решается «отдавать эту котировку или нет».
   * `null` — не отдавать: либо порога нет (судить нечем), либо цена старше
   * порога. Возвращать вместо неё ноль или прошлое значение нельзя: отказ,
   * выглядящий правдоподобным значением, — тот самый класс дефектов.
   */
  private pick(quote: Quote | undefined, at: number): Quote | null {
    if (!quote) return null;
    if (this.staleAfterMs === null) return null;
    if (at - quote.ts > this.staleAfterMs) return null;
    return quote;
  }

  private flush() {
    const at = this.now();
    for (const [id, state] of this.clients) {
      if (state.dirty.size === 0) continue;
      const batch: Quote[] = [];
      for (const symbol of state.dirty) {
        const quote = this.pick(this.last.get(symbol), at);
        if (quote) batch.push(quote);
      }
      state.dirty.clear();
      if (batch.length) this.io.to(id).emit('quotes:batch', batch);
    }
  }

  /**
   * Снапшот. `symbols` не задан → вся вселенная, что у нас в памяти.
   * Протухшее в `items` не попадает **вовсе** (решение штаба, §5б):
   * отсутствие символа прочитать неправильно нельзя, а поле возраста рядом
   * с ценой потребитель проигнорирует.
   */
  snapshot(symbols?: string[]): SnapshotResult {
    const at = this.now();
    const candidates =
      !symbols || symbols.length === 0
        ? [...this.last.values()]
        : symbols.map((s) => this.last.get(s)).filter((q): q is Quote => q !== undefined);

    const items: Quote[] = [];
    const staleSymbols: string[] = [];
    for (const quote of candidates) {
      if (this.pick(quote, at)) items.push(quote);
      else staleSymbols.push(quote.symbol);
    }

    return {
      items,
      // Порога нет — мы ничего не «признали протухшим», мы просто не судили.
      // `[]` здесь соврало бы ровно то, против чего написано §5г.
      staleSymbols: this.staleAfterMs === null ? null : staleSymbols,
      checked: candidates.length,
    };
  }

  /** Возраст каждой котировки в памяти, мс. Для /health. */
  ages(): { symbol: string; ageMs: number }[] {
    const at = this.now();
    return [...this.last.values()].map((q) => ({ symbol: q.symbol, ageMs: at - q.ts }));
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

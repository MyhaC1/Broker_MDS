import type { CatalogInstrument, Quote } from '../types.js';
import type { ProviderStatus } from './binance.js';

/**
 * Провайдер Twelve Data (форекс, металлы, акции, индексы): REST-поллер
 * /quote батчами. Архитектура «как для PRO», бюджет — конфиг:
 *  - 1 символ в батче = 1 кредит; чанк ≤ creditsPerMin (не упираемся
 *    в минутный лимит одним запросом);
 *  - интервал между запросами растянут под creditsPerDay (с резервом 10%) —
 *    free-ключ 800/день на ~17 символах даёт обновление каждые ~30 мин,
 *    PRO-ключ → env повыше и поллер ускоряется сам;
 *  - символ, отвергнутый тарифом (404/план), уходит в чёрный список до
 *    рестарта — кредиты на него больше не тратятся;
 *  - top-level 429 → пауза минута без смены чанка.
 * WebSocket Twelve Data — апгрейд внутри этого же класса, потребители
 * (hub) разницы не заметят.
 */

interface TwelveQuote {
  symbol?: string;
  close?: string;
  percent_change?: string;
  timestamp?: number;
  code?: number;
  message?: string;
  status?: string;
}

export interface TwelveDataConfig {
  apiKey: string;
  apiUrl: string;
  creditsPerMin: number;
  creditsPerDay: number;
}

export function normalizeTwelveQuote(
  entry: TwelveQuote,
  instrument: CatalogInstrument,
): Quote | null {
  const price = Number.parseFloat(entry.close ?? '');
  const changePercent = Number.parseFloat(entry.percent_change ?? '');
  if (!Number.isFinite(price)) return null;
  return {
    symbol: instrument.symbol,
    name: instrument.name,
    category: instrument.category,
    price,
    digits: instrument.digits,
    changePercent: Number.isFinite(changePercent) ? changePercent : 0,
    ts: entry.timestamp ? entry.timestamp * 1000 : Date.now(),
  };
}

export class TwelveDataProvider {
  private instruments: CatalogInstrument[] = [];
  private readonly blacklist = new Set<string>();

  /** Канонические символы, отвергнутые тарифом (для фильтра вселенной). */
  get rejectedSymbols(): string[] {
    return this.instruments
      .filter((i) => this.blacklist.has(i.providerSymbol))
      .map((i) => i.symbol);
  }
  private chunkIndex = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  status: ProviderStatus = 'connecting';
  lastTickAt = 0;

  constructor(
    private readonly onQuote: (q: Quote) => void,
    private readonly cfg: TwelveDataConfig,
  ) {}

  setInstruments(instruments: CatalogInstrument[]) {
    this.instruments = instruments;
  }

  private get chunkSize(): number {
    return Math.max(1, Math.min(this.cfg.creditsPerMin, 8));
  }

  /** Пауза между запросами: минутный лимит И дневной бюджет (резерв 10%). */
  private get intervalMs(): number {
    const dailyBudget = Math.max(1, Math.floor(this.cfg.creditsPerDay * 0.9));
    const byDay = Math.ceil((86_400_000 * this.chunkSize) / dailyBudget);
    return Math.max(60_000, byDay);
  }

  connect() {
    if (!this.cfg.apiKey || this.instruments.length === 0) return;
    void this.poll();
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => void this.poll(), delayMs);
    this.timer.unref();
  }

  private activeChunks(): CatalogInstrument[][] {
    const active = this.instruments.filter((i) => !this.blacklist.has(i.providerSymbol));
    const chunks: CatalogInstrument[][] = [];
    for (let n = 0; n < active.length; n += this.chunkSize) {
      chunks.push(active.slice(n, n + this.chunkSize));
    }
    return chunks;
  }

  private async poll() {
    const chunks = this.activeChunks();
    if (chunks.length === 0) return;
    const chunk = chunks[this.chunkIndex % chunks.length]!;
    const symbols = chunk.map((i) => i.providerSymbol).join(',');

    try {
      const url = `${this.cfg.apiUrl}/quote?symbol=${encodeURIComponent(symbols)}&apikey=${this.cfg.apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const data = (await res.json()) as TwelveQuote | Record<string, TwelveQuote>;

      // Top-level ошибка (429 исчерпан лимит / 401 ключ): чанк не двигаем
      if (typeof (data as TwelveQuote).code === 'number' && !(data as TwelveQuote).close) {
        const top = data as TwelveQuote;
        console.warn(`[twelvedata] API ${top.code}: ${top.message ?? ''}`);
        this.status = 'reconnecting';
        this.schedule(top.code === 429 ? 60_000 : this.intervalMs);
        return;
      }

      let gotAny = false;
      for (const instrument of chunk) {
        const entry =
          chunk.length === 1
            ? (data as TwelveQuote)
            : (data as Record<string, TwelveQuote>)[instrument.providerSymbol];
        if (!entry) continue;
        if (typeof entry.code === 'number') {
          // Символ не входит в тариф/не найден — не жжём кредиты дальше
          this.blacklist.add(instrument.providerSymbol);
          console.warn(
            `[twelvedata] ${instrument.providerSymbol} отклонён (${entry.code}: ${entry.message ?? ''}) — в чёрный список`,
          );
          continue;
        }
        const quote = normalizeTwelveQuote(entry, instrument);
        if (quote) {
          gotAny = true;
          this.lastTickAt = Date.now();
          this.onQuote(quote);
        }
      }
      if (gotAny) this.status = 'connected';
      this.chunkIndex += 1;
      // Первый прогон: пройти все чанки подряд (минутный лимит уважаем),
      // чтобы снапшот наполнился, дальше — крейсерский интервал
      const warmup = this.chunkIndex < chunks.length;
      this.schedule(warmup ? 61_000 : this.intervalMs);
    } catch (error) {
      console.warn('[twelvedata] poll fail:', (error as Error).message);
      this.status = 'reconnecting';
      this.schedule(this.intervalMs);
    }
  }
}

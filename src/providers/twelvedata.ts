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
  /** id источника из реестра провайдеров: уходит в `Quote.source` (Р-047). */
  id: string;
  apiKey: string;
  apiUrl: string;
  creditsPerMin: number;
  creditsPerDay: number;
}

/**
 * Разбор котировки Twelve Data. `null` вместо котировки, если непригодна
 * хоть одна из трёх величин: цена, изменение, момент.
 *
 * **Поправка 20.10 (QA-05).** Здесь стояли два умолчания, и оба были
 * записаны как осознанные — с объяснением рядом, как и положено. Одно
 * обоснование устарело, второе оказалось неполным.
 *
 * 1. ~~`changePercent` → 0: «умолчание в проценте изменения — косметика».~~
 *    **Отменено.** Приём, выведенный терминалом: границы просматривают
 *    начиная с полей, которые отображаются **цветом, стрелкой или знаком**.
 *    `changePercent` — ровно такое поле: ноль со знаком рисуется как
 *    «+0.00%», то есть как **утверждение о рынке**, а знали мы только
 *    «процент не разобрали». Прочерк читается как «неизвестно» мгновенно,
 *    зелёный ноль — нет.
 *
 *    И вторая половина той же находки: **два ответа одного сервиса про одну
 *    величину обязаны говорить одинаково.** Соседний адаптер (`binance.ts`,
 *    `normalizeTick`) с самого начала отвергает тик целиком при
 *    неразобранном `changePercent`. Правильный ответ лежал рядом с
 *    неправильным — и маскировал его.
 *
 * 2. ~~Нет `timestamp` — берём своё время, иначе `ts: 0` означало бы
 *    «котировки нет».~~ **Отменено.** Про `0` рассуждение верное, но из
 *    него не следует, что верен `Date.now()`: исходов три, а рассмотрено
 *    было два. `Date.now()` утверждает «цена получена сейчас», а известно
 *    только «момента нам не прислали».
 *
 *    Цена этого умолчания не косметическая. `ts` течёт прямо в фильтр
 *    свежести (`hub.pick`: `at - quote.ts > staleAfterMs`), поэтому
 *    котировка с выдуманным моментом **не протухает никогда**. Источник,
 *    отвечающий телом без времени, выдавал бы вчерашнюю цену как текущую
 *    бесконечно — против этого и написан §5г, ради этого MDS вообще держит
 *    порог свежести.
 *
 * Отказ здесь **fail-closed и не молчаливый**: вызывающий считает
 * отброшенные записи и называет их числом (`dropped`), иначе «источник
 * ничего не прислал» было бы неотличимо от «всё отбросили».
 */
export function normalizeTwelveQuote(
  entry: TwelveQuote,
  instrument: CatalogInstrument,
  sourceId: string,
): Quote | null {
  const price = Number.parseFloat(entry.close ?? '');
  const changePercent = Number.parseFloat(entry.percent_change ?? '');
  if (!Number.isFinite(price)) return null;
  if (!Number.isFinite(changePercent)) return null;
  // Ноль здесь тоже непригоден: эпоха 1970 — не момент котировки, а признак
  // того, что поля не было. Разбор и пригодность — разные барьеры.
  const seconds = entry.timestamp;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return {
    symbol: instrument.symbol,
    name: instrument.name,
    category: instrument.category,
    price,
    digits: instrument.digits,
    changePercent,
    ts: seconds * 1000,
    source: sourceId,
  };
}

/**
 * Размер батча: 1 символ = 1 кредит, и в один запрос не кладём больше, чем
 * минутный лимит, иначе упрёмся в него одним обращением.
 */
export function chunkSizeFor(cfg: Pick<TwelveDataConfig, 'creditsPerMin'>): number {
  return Math.max(1, Math.min(cfg.creditsPerMin, 8));
}

/**
 * Пауза между запросами: минутный лимит И дневной бюджет (резерв 10%).
 * Вынесено из класса чистой функцией — по этому числу считается, могут ли
 * котировки Twelve Data вообще быть свежими (тест-растяжка в
 * `twelvedata.test.ts`: на free-тарифе интервал 16 минут, и любой разумный
 * порог свежести делает их протухшими по построению).
 */
export function pollIntervalMs(cfg: Pick<TwelveDataConfig, 'creditsPerMin' | 'creditsPerDay'>): number {
  const dailyBudget = Math.max(1, Math.floor(cfg.creditsPerDay * 0.9));
  const byDay = Math.ceil((86_400_000 * chunkSizeFor(cfg)) / dailyBudget);
  return Math.max(60_000, byDay);
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
  /**
   * Сколько записей отброшено как непригодные за жизнь процесса. Нужен,
   * чтобы «источник молчит» было отличимо от «источник отвечает, и всё
   * отвечаемое мы выбрасываем»: снаружи оба выглядят одинаково — цены нет.
   */
  droppedTotal = 0;

  constructor(
    private readonly onQuote: (q: Quote) => void,
    private readonly cfg: TwelveDataConfig,
  ) {}

  get id(): string {
    return this.cfg.id;
  }

  setInstruments(instruments: CatalogInstrument[]) {
    this.instruments = instruments;
  }

  private get chunkSize(): number {
    return chunkSizeFor(this.cfg);
  }

  private get intervalMs(): number {
    return pollIntervalMs(this.cfg);
  }

  connect() {
    if (!this.cfg.apiKey || this.instruments.length === 0) return;
    void this.poll();
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => void this.poll(), delayMs);
    this.timer.unref?.();
  }

  /** Остановка поллера (тесты, штатное завершение). */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Один цикл опроса вручную — для тестов, чтобы не ждать расписания. */
  async pollOnce(): Promise<void> {
    await this.poll();
    this.stop();
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
      const dropped: string[] = [];
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
        const quote = normalizeTwelveQuote(entry, instrument, this.cfg.id);
        if (quote) {
          gotAny = true;
          this.lastTickAt = Date.now();
          this.onQuote(quote);
        } else {
          // Отброшенное считаем и называем. Мягкий разбор означает «не
          // падает», а не «исчезает без следа»: без счётчика «источник
          // ничего не прислал» неотличимо от «всё пришедшее отбросили», а
          // чинятся они по-разному. Отброс стал возможен чаще с QA-05 —
          // тем нужнее след.
          dropped.push(instrument.providerSymbol);
          this.droppedTotal += 1;
        }
      }
      if (dropped.length > 0) {
        console.warn(
          `[twelvedata] отброшено ${dropped.length} записей из ${chunk.length}: ` +
            'непригодны цена, изменение или момент (QA-05, умолчания сняты). ' +
            `Символы: ${dropped.slice(0, 10).join(', ')}. Всего за жизнь процесса: ${this.droppedTotal}.`,
        );
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

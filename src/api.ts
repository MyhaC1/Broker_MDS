import type { SnapshotResult } from './hub.js';

/**
 * Тела ответов `/health` и `/v1/quotes` — чистыми функциями, отдельно от
 * HTTP-обвязки. Причина не в красоте: `index.ts` — скрипт верхнего уровня
 * (top-level await за каталогом, `listen`), импортировать его в тест нельзя,
 * и до сих пор ровно та логика, из-за которой случился B-003, не могла быть
 * покрыта ничем.
 */

/** Что провайдер сообщает о себе. Состояния сокета здесь нет сознательно. */
export interface ProviderView {
  name: string;
  /** Момент последнего ОПОЗНАННОГО тика, unix ms. 0 — тиков не было. */
  lastTickAt: number;
}

export interface HealthInput {
  /** Возрасты котировок в памяти — источник правды о живости сервиса. */
  ages: { symbol: string; ageMs: number }[];
  providers: ProviderView[];
  /** Канонический символ → провайдер, для разбивки возрастов. */
  providerOf: Map<string, string>;
  /**
   * Провайдер, по которому судим о здоровье сервиса целиком. Twelve Data —
   * поллер: между опросами его молчание штатно и деградацией не является.
   */
  primaryProvider: string;
  staleAfterMs: number | null;
  catalog: { source: string; instruments: number };
  clients: number;
  startedAt: number;
  now?: number;
}

export interface ProviderHealth {
  name: string;
  lastTickAt: number;
  /** Возраст последнего тика, мс. `null` — тиков не было ни одного. */
  lastTickAgeMs: number | null;
  /** Сколько символов этого провайдера есть в памяти. */
  quoted: number;
  /** Сколько из них свежее порога. `null` — порога нет, не считали. */
  fresh: number | null;
  stale: number | null;
  /** Возраст самой старой котировки провайдера, мс. */
  oldestQuoteAgeMs: number | null;
}

export interface HealthBody {
  status: 'ok' | 'degraded';
  reason?: string;
  quotes: { staleAfterMs: number | null; total: number; fresh: number | null };
  providers: ProviderHealth[];
  catalog: { source: string; instruments: number };
  clients: number;
  uptimeSec: number;
  time: string;
}

/**
 * `/health`. Судит о провайдере по **возрасту данных**, а не по состоянию
 * сокета (B-003): открытый сокет ничего не говорит о наличии котировок, и
 * один раз принятый за признак жизни будет принят снова. Состояние сокета
 * наружу не отдаётся вовсе — по той же причине, по какой у терминала убрали
 * зелёную точку: поле, способное соврать, хуже отсутствующего.
 */
export function buildHealth(input: HealthInput): { httpStatus: 200 | 503; body: HealthBody } {
  const now = input.now ?? Date.now();
  const { staleAfterMs } = input;

  const perProvider = new Map<string, { quoted: number; fresh: number; oldestMs: number | null }>();
  for (const { symbol, ageMs } of input.ages) {
    const provider = input.providerOf.get(symbol) ?? 'unknown';
    const acc = perProvider.get(provider) ?? { quoted: 0, fresh: 0, oldestMs: null };
    acc.quoted += 1;
    if (staleAfterMs !== null && ageMs <= staleAfterMs) acc.fresh += 1;
    acc.oldestMs = acc.oldestMs === null ? ageMs : Math.max(acc.oldestMs, ageMs);
    perProvider.set(provider, acc);
  }

  const providers: ProviderHealth[] = input.providers.map((p) => {
    const acc = perProvider.get(p.name) ?? { quoted: 0, fresh: 0, oldestMs: null };
    return {
      name: p.name,
      lastTickAt: p.lastTickAt,
      lastTickAgeMs: p.lastTickAt === 0 ? null : now - p.lastTickAt,
      quoted: acc.quoted,
      fresh: staleAfterMs === null ? null : acc.fresh,
      stale: staleAfterMs === null ? null : acc.quoted - acc.fresh,
      oldestQuoteAgeMs: acc.oldestMs,
    };
  });

  const primary = providers.find((p) => p.name === input.primaryProvider);
  // Порог не задан → свежесть не проверялась. Это «результат неизвестен», а
  // не «всё хорошо»: невыполненная проверка обязана быть отличима от
  // пройденной, и называется она первой строкой — в `reason`.
  const reason =
    staleAfterMs === null
      ? 'QUOTE_STALE_AFTER_MS не задан — свежесть не проверялась, котировки не отдаются'
      : !primary
        ? `провайдер ${input.primaryProvider} не подключён к сервису`
        : (primary.fresh ?? 0) === 0
          ? `у ${primary.name} нет ни одной котировки свежее ${staleAfterMs} мс`
          : null;

  const body: HealthBody = {
    status: reason === null ? 'ok' : 'degraded',
    ...(reason === null ? {} : { reason }),
    quotes: {
      staleAfterMs,
      total: input.ages.length,
      fresh: staleAfterMs === null ? null : providers.reduce((n, p) => n + (p.fresh ?? 0), 0),
    },
    providers,
    catalog: input.catalog,
    clients: input.clients,
    uptimeSec: Math.round((now - input.startedAt) / 1000),
    time: new Date(now).toISOString(),
  };

  return { httpStatus: reason === null ? 200 : 503, body };
}

export interface QuotesBody extends SnapshotResult {
  /** Порог, по которому решено, что протухло. `null` — порога нет. */
  staleAfterMs: number | null;
  reason?: string;
}

/**
 * `/v1/quotes`. Протухшие котировки не отдаются **вовсе** — ни нулём, ни
 * старым значением (решение штаба, КОНТРАКТЫ.md §5б). Рядом с `items` идут
 * список протухших символов и порог, по которому это решено: без них
 * потребитель не отличит «MDS считает всё свежим» от «MDS не считает вовсе».
 */
export function buildQuotes(snapshot: SnapshotResult, staleAfterMs: number | null): QuotesBody {
  return {
    items: snapshot.items,
    staleAfterMs,
    // `null` ≠ `[]`: пустой массив — «считали, протухших не нашли»,
    // null — «источник ничего не сказал» (§5г, требование 1).
    staleSymbols: snapshot.staleSymbols,
    // Охват проверки: без него «протухших нет» неотличимо от «проверять
    // было нечего».
    checked: snapshot.checked,
    ...(staleAfterMs === null
      ? { reason: 'QUOTE_STALE_AFTER_MS не задан — свежесть не проверялась' }
      : {}),
  };
}

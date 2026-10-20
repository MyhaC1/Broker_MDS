import type { SnapshotResult } from './hub.js';
import type { RouteReason } from './registry.js';
import type { RegistryOrigin } from './registry-store.js';

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

/**
 * Состояние реестра провайдеров для `/health`. Обязательное поле, а не
 * необязательное: необязательное оставило бы ту же дыру — вызов, забывший
 * его передать, молча отчитывался бы о здоровье сервиса, не взглянув на то,
 * настроены ли у него источники вообще.
 */
export interface RegistryHealthInput {
  origin: RegistryOrigin;
  error?: string;
  /** `null` ровно и только при `origin === 'error'`. */
  version: number | null;
  providers: { id: string; enabled: boolean; silent: boolean }[];
  /** Сколько символов сейчас кому-то назначено и сколько осмотрено всего. */
  routed: number;
  checked: number;
  /**
   * Включённые источники, которым нужен ключ, а ключа нет. Такой источник
   * не запущен вовсе, и без отдельного поля он выглядел бы просто молчащим —
   * то есть отказ настройки был бы неотличим от отказа сети.
   */
  missingKeys: string[];
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
  registry: RegistryHealthInput;
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
  registry: RegistryHealthInput;
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
  const registry = input.registry;
  const enabledProviders = registry.providers.filter((p) => p.enabled);

  // Порядок причин — от «мы не знаем, чем работать» к «работаем, но плохо».
  // Каждая ветка — своё состояние; ни одна из них не «ноль инструментов».
  //
  // Три состояния реестра, которые нельзя сливать в одно:
  //   error            — реестр не прочитан, чем работать неизвестно;
  //   пустой реестр    — прочитан, источников в нём нет ни одного;
  //   всё выключено    — источники есть, включённых нет.
  // Снаружи это три разных ответа, потому что чинят их по-разному.
  const reason =
    registry.origin === 'error'
      ? `реестр провайдеров не прочитан (${registry.error ?? 'причина не названа'}) — источники не запущены`
      : registry.providers.length === 0
        ? 'реестр провайдеров пуст — ни один источник не описан'
        : enabledProviders.length === 0
          ? 'в реестре провайдеров нет ни одного включённого источника'
          : registry.missingKeys.length > 0
            ? `включён источник без ключа: ${registry.missingKeys.join(', ')} — он не запущен`
            : registry.routed === 0
            ? `ни один из ${registry.checked} символов каталога не назначен источнику`
            : staleAfterMs === null
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
    registry,
    clients: input.clients,
    uptimeSec: Math.round((now - input.startedAt) / 1000),
    time: new Date(now).toISOString(),
  };

  return { httpStatus: reason === null ? 200 : 503, body };
}

/**
 * Почему символа нет в ответе. Коды машинные и **не переводятся**: подпись
 * для человека и признак для машины — разные поля.
 *
 * До Р-047 все эти случаи выглядели снаружи одинаково — символа просто нет в
 * `items`. То есть «источник выключен оператором», «источник молчит»,
 * «такого инструмента у нас нет» и «цена протухла» были неразличимы, и
 * потребитель мог прочитать любой из них как «пока не приехало».
 */
export const UNAVAILABLE_REASONS = [
  /** Порог свежести не задан — судить о свежести нечем, не отдаём ничего. */
  'threshold-unset',
  /** Цена есть, но старше порога. */
  'stale',
  /** Источник назначен и включён, но цены от него нет (ещё или уже). */
  'source-silent',
  /** Источники для символа есть, но все выключены в реестре. */
  'source-disabled',
  /** Ни один источник реестра не ведёт этот символ. */
  'no-source',
  /** Символа нет во вселенной MDS вообще. */
  'not-in-catalog',
  /** Реестр не прочитан — маршрутизации нет, работать нечем. */
  'registry-unreadable',
] as const;

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** Что маршрутизация знает о символах. `readable: false` — реестра нет вовсе. */
export interface QuotesRouting {
  readable: boolean;
  reasons: Map<string, RouteReason>;
}

export interface QuotesBody extends SnapshotResult {
  /** Порог, по которому решено, что протухло. `null` — порога нет. */
  staleAfterMs: number | null;
  /**
   * Символы, которых в `items` нет, с названной причиной по каждому.
   * Это главное, что реестр добавил к ответу: отсутствие строки перестало
   * быть единственным сообщением обо всех отказах сразу.
   */
  unavailable: { symbol: string; reason: UnavailableReason }[];
  reason?: string;
}

function routeToUnavailable(reason: RouteReason | undefined): UnavailableReason {
  switch (reason) {
    case 'no-source':
      return 'no-source';
    case 'source-disabled':
      return 'source-disabled';
    case 'primary':
    case 'failover':
    case 'silent':
      // Маршрут есть, цены нет: источник назначен, но молчит — это не то же
      // самое, что «источника нет», и чинится другим.
      return 'source-silent';
    default:
      return 'not-in-catalog';
  }
}

/**
 * `/v1/quotes`. Протухшие котировки не отдаются **вовсе** — ни нулём, ни
 * старым значением (решение штаба, КОНТРАКТЫ.md §5б). Рядом с `items` идут
 * список протухших символов и порог, по которому это решено: без них
 * потребитель не отличит «MDS считает всё свежим» от «MDS не считает вовсе».
 *
 * `requested` — символы, которые спросили явно; `null` — спросили всё.
 * Разница важна: в первом случае отвечать надо про каждый спрошенный символ
 * (включая неизвестные), во втором — про всю вселенную маршрутизации.
 */
export function buildQuotes(
  snapshot: SnapshotResult,
  staleAfterMs: number | null,
  routing: QuotesRouting,
  requested: string[] | null,
): QuotesBody {
  const unavailable: { symbol: string; reason: UnavailableReason }[] = [];
  const fresh = new Set(snapshot.items.map((q) => q.symbol));

  if (!routing.readable) {
    // Реестр не прочитан: причина у всех одна, и она блокирующая. Подменять
    // её на «источник молчит» значило бы отправить чинить не то.
    for (const symbol of requested ?? [...routing.reasons.keys()]) {
      unavailable.push({ symbol, reason: 'registry-unreadable' });
    }
    return {
      items: [],
      staleAfterMs,
      staleSymbols: snapshot.staleSymbols,
      checked: snapshot.checked,
      missing: snapshot.missing,
      unavailable,
      reason: 'реестр провайдеров не прочитан — котировки не отдаются',
    };
  }

  const universe = requested ?? [...routing.reasons.keys()];
  for (const symbol of universe) {
    if (fresh.has(symbol)) continue;
    if (staleAfterMs === null) {
      unavailable.push({ symbol, reason: 'threshold-unset' });
      continue;
    }
    // Цена в памяти есть, но не прошла порог — это `stale`, и перепутать её
    // с «источник молчит» нельзя: у них разные виноватые.
    unavailable.push({
      symbol,
      reason: snapshot.staleSymbols?.includes(symbol)
        ? 'stale'
        : routeToUnavailable(routing.reasons.get(symbol)),
    });
  }

  return {
    items: snapshot.items,
    staleAfterMs,
    // `null` ≠ `[]`: пустой массив — «считали, протухших не нашли»,
    // null — «источник ничего не сказал» (§5г, требование 1).
    staleSymbols: snapshot.staleSymbols,
    // Охват проверки: без него «протухших нет» неотличимо от «проверять
    // было нечего».
    checked: snapshot.checked,
    missing: snapshot.missing,
    unavailable,
    ...(staleAfterMs === null
      ? { reason: 'QUOTE_STALE_AFTER_MS не задан — свежесть не проверялась' }
      : {}),
  };
}

import { z } from 'zod';
import type { CatalogInstrument, Quote } from './types.js';

/**
 * Реестр провайдеров: какие источники известны, какой ведёт какие символы,
 * какой включён. Р-047.
 *
 * Провайдер перестал быть свойством сборки и стал **настраиваемым
 * состоянием**: раньше набор источников задавался кодом и переменными
 * окружения, теперь — данными, которые читает и меняет служебная ручка.
 *
 * **Что здесь данные, а что код — граница честная (Р-047).** Включить,
 * выключить, переставить приоритет, переназначить покрытие категорий —
 * данные. Источник с чужим протоколом — новый адаптер, то есть код.
 * Поэтому `adapter` берётся из закрытого перечня: запись реестра, ссылающаяся
 * на несуществующий адаптер, — это запись, которую никто не сможет исполнить,
 * и принимать её значит обещать систему плагинов, которой не будет.
 *
 * Весь разбор здесь **строгий** (`.strict()`): это производитель состояния.
 * Незнакомое поле, молча отброшенное, — это настройка, которую администратор
 * считает заданной, а она не задана. Мягкость полагается потребителю, а не
 * тому, кто принимает изменение регуляторно значимого состояния.
 */

export const CATEGORIES = [
  'forex',
  'metals',
  'crypto',
  'indices',
  'stocks',
  'energy',
] as const satisfies readonly Quote['category'][];

export type Category = Quote['category'];

/** Адаптеры, для которых в сервисе есть код. Расширяется только правкой кода. */
export const ADAPTER_KINDS = ['binance', 'twelvedata'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

const categorySchema = z.enum(CATEGORIES);

const providerSchema = z
  .object({
    /** Стабильный идентификатор источника. Он же ключ маршрутизации и провенанса. */
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'id: строчные латинские, цифры и дефис, до 32 символов'),
    /** Какой код обслуживает источник. Закрытый перечень — см. шапку файла. */
    adapter: z.enum(ADAPTER_KINDS),
    label: z.string().min(1).max(80),
    enabled: z.boolean(),
    /** Меньше — раньше в очереди кандидатов на ведение символа. */
    priority: z.number().int().min(0).max(10_000),
    /** Какие категории источник ведёт. Пустой список = источник не ведёт ничего. */
    covers: z.array(categorySchema).max(CATEGORIES.length),
    /**
     * Сколько молчания считать отказом источника, мс. `null` — **молчание
     * этого источника отказом не является**: поллер между опросами молчит
     * штатно (Twelve Data на free-тарифе — 16 минут), и таймер тишины,
     * применённый к нему, устроил бы вечный failover на ровном месте.
     * Это поле и есть ответ на «почему молчащий поллер не считается мёртвым»,
     * записанный данными, а не зашитый в условие по имени провайдера.
     */
    maxSilenceMs: z.number().int().positive().nullable(),
    /** Нужен ли ключ. Сам ключ в реестре не живёт — см. ADR-031, раздел о ключах. */
    requiresKey: z.boolean(),
  })
  .strict();

export const registrySchema = z
  .object({
    version: z.number().int().min(0),
    updatedAt: z.string().min(1),
    updatedBy: z.string().min(1).max(120),
    providers: z.array(providerSchema).max(32),
    /**
     * Разрешение **коллизии канонического символа** — это не то же самое, что
     * выбор источника. Binance отдаёт пару EUR/USDT, Twelve Data — курс
     * EUR/USD; оба канонизируются в `EURUSD`, но это **разные активы**, а не
     * два источника одного. Приоритет провайдера тут не при чём: он решал бы,
     * чья цена, а решать надо, какой инструмент. Поэтому коллизия решается
     * precedence категорий, и порядок лежит данными — чтобы правило было
     * видно снаружи, а не только в `console.info`, как было до Р-047.
     */
    categoryPrecedence: z.array(categorySchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const p of value.providers) {
      if (ids.has(p.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `дубль id провайдера: ${p.id}` });
      }
      ids.add(p.id);
    }
    const seen = new Set<Category>();
    for (const c of value.categoryPrecedence) {
      if (seen.has(c)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `дубль категории в precedence: ${c}` });
      }
      seen.add(c);
    }
    // Неполный precedence оставил бы часть коллизий без правила, и решал бы
    // их порядок перечисления в каталоге — то есть случайность.
    for (const c of CATEGORIES) {
      if (!seen.has(c)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `categoryPrecedence не покрывает категорию ${c} — коллизии по ней решать нечем`,
        });
      }
    }
  });

export type ProviderEntry = z.infer<typeof providerSchema>;
export type Registry = z.infer<typeof registrySchema>;

/**
 * Встроенное умолчание. Оно **не является выбором владельца** и обязано
 * называть себя умолчанием везде, где показывается (см. `RegistryOrigin`):
 * это ровно тот класс, на котором мы уже горели — запасной каталог из 33
 * инструментов, принятый штабом за живые 500.
 *
 * Состав умолчания повторяет поведение до Р-047 ровно, чтобы переход на
 * реестр ничего не менял молча: Binance включён (публичные данные, ключ не
 * нужен), Twelve Data выключен (ключа нет).
 */
export function builtinRegistry(): Registry {
  return {
    version: 0,
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'builtin-default',
    providers: [
      {
        id: 'binance',
        adapter: 'binance',
        label: 'Binance — публичные данные, ключ не нужен',
        enabled: true,
        priority: 10,
        covers: ['crypto'],
        maxSilenceMs: 60_000,
        requiresKey: false,
      },
      {
        id: 'twelvedata',
        adapter: 'twelvedata',
        label: 'Twelve Data — форекс, металлы, акции, индексы',
        enabled: false,
        priority: 20,
        covers: ['forex', 'metals', 'stocks', 'indices'],
        // Поллер: молчание между опросами штатно, таймером тишины не судится.
        maxSilenceMs: null,
        requiresKey: true,
      },
    ],
    // Настоящий инструмент важнее крипто-пары к USDT с тем же каноническим
    // именем: до Р-047 это же правило было зашито в index.ts одной строкой.
    categoryPrecedence: ['forex', 'metals', 'indices', 'stocks', 'energy', 'crypto'],
  };
}

/* ------------------------------------------------------------------ */
/* Маршрутизация: символ → ведущий источник                            */
/* ------------------------------------------------------------------ */

/**
 * Почему у символа такой ведущий — и почему его нет. Коды машинные и
 * **не переводятся**: подпись для человека и признак для машины — разные
 * поля, перевод в признаке мы уже ловили.
 */
export type RouteReason =
  /** Ведёт источник с лучшим приоритетом, он жив. */
  | 'primary'
  /** Основной молчит дольше своего `maxSilenceMs`, ведёт запасной. */
  | 'failover'
  /** Кандидат один (или все остальные молчат) и он сам молчит. Цены нет. */
  | 'silent'
  /** Источники для символа есть, но все выключены в реестре. */
  | 'source_disabled'
  /** Ни один источник реестра не ведёт этот символ. */
  | 'no_source';

export interface RouteCandidate {
  providerId: string;
  priority: number;
  enabled: boolean;
  silent: boolean;
}

export interface Route {
  symbol: string;
  category: Category;
  /** Кому отдана трансляция символа. `null` — никому, см. `reason`. */
  leader: { providerId: string; instrument: CatalogInstrument } | null;
  reason: RouteReason;
  candidates: RouteCandidate[];
  /**
   * Записи каталога, проигравшие коллизию канонического символа. До Р-047
   * они исчезали в `console.info` — то есть снаружи сервиса не существовали.
   */
  hiddenByCollision: { providerId: string; category: Category }[];
}

export interface RoutingRuntime {
  /** Источники, признанные молчащими (по их собственному `maxSilenceMs`). */
  silent: Set<string>;
  /**
   * Залипший выбор после failover: символ → источник, на который уже
   * переключились. **Автоматического возврата нет и это решение, а не
   * недоделка** (ADR-031): каждая смена источника — разрыв цены, и возврат
   * «как только основной ожил» дал бы второй разрыв плюс дребезг на
   * неустойчивом канале. Снимается оператором или рестартом.
   */
  sticky: Map<string, string>;
}

export interface RoutingTable {
  routes: Map<string, Route>;
  /** Источник → инструменты, которые он сейчас обязан транслировать. */
  byProvider: Map<string, CatalogInstrument[]>;
  /** Символы, ведомые не основным кандидатом: вход для `sticky` следующего круга. */
  failedOver: Map<string, string>;
}

function emptyRuntime(): RoutingRuntime {
  return { silent: new Set(), sticky: new Map() };
}

/**
 * Чистая функция: каталог + реестр + состояние источников → кто что ведёт.
 *
 * Порядок решений — от определения инструмента к выбору источника:
 *  1. коллизия канонического имени решается precedence **категорий**;
 *  2. кандидаты — источники реестра, чья `covers` включает категорию символа
 *     и у которых этот символ есть в каталоге;
 *  3. ведущий — залипший после failover, иначе лучший по приоритету живой,
 *     иначе лучший по приоритету включённый (и тогда `silent`).
 *
 * Молчаливого «берём первого» здесь нет ни в одной ветке: у каждого исхода
 * свой `reason`, и «источника нет» отличимо от «источник выключен» и от
 * «источник молчит».
 */
export function resolveRouting(
  instruments: CatalogInstrument[],
  registry: Registry,
  runtime: RoutingRuntime = emptyRuntime(),
): RoutingTable {
  const byId = new Map(registry.providers.map((p) => [p.id, p]));
  const rank = new Map(registry.categoryPrecedence.map((c, index) => [c, index]));

  const bySymbol = new Map<string, CatalogInstrument[]>();
  for (const instrument of instruments) {
    const list = bySymbol.get(instrument.symbol);
    if (list) list.push(instrument);
    else bySymbol.set(instrument.symbol, [instrument]);
  }

  const routes = new Map<string, Route>();
  const byProvider = new Map<string, CatalogInstrument[]>();
  const failedOver = new Map<string, string>();
  for (const provider of registry.providers) byProvider.set(provider.id, []);

  for (const [symbol, entries] of bySymbol) {
    const rankOf = (c: Category) => rank.get(c) ?? Number.MAX_SAFE_INTEGER;
    const bestRank = Math.min(...entries.map((e) => rankOf(e.category)));
    const winners = entries.filter((e) => rankOf(e.category) === bestRank);
    const hiddenByCollision = entries
      .filter((e) => rankOf(e.category) !== bestRank)
      .map((e) => ({ providerId: e.provider, category: e.category }));
    const category = winners[0]!.category;

    // Кандидат — запись каталога, чей источник есть в реестре и чья категория
    // этим источником объявлена. Источник, не объявивший категорию, символ не
    // ведёт, даже если строка каталога на него ссылается: `covers` — это то,
    // чем управляет оператор, а каталог — то, что умеет адаптер.
    const candidateEntries = winners
      .map((instrument) => ({ instrument, provider: byId.get(instrument.provider) }))
      .filter((c): c is { instrument: CatalogInstrument; provider: ProviderEntry } =>
        c.provider !== undefined && c.provider.covers.includes(category),
      )
      .sort(
        (a, b) => a.provider.priority - b.provider.priority || a.provider.id.localeCompare(b.provider.id),
      );

    const candidates: RouteCandidate[] = candidateEntries.map((c) => ({
      providerId: c.provider.id,
      priority: c.provider.priority,
      enabled: c.provider.enabled,
      silent: runtime.silent.has(c.provider.id),
    }));

    if (candidateEntries.length === 0) {
      routes.set(symbol, {
        symbol,
        category,
        leader: null,
        reason: 'no_source',
        candidates,
        hiddenByCollision,
      });
      continue;
    }

    const enabled = candidateEntries.filter((c) => c.provider.enabled);
    if (enabled.length === 0) {
      routes.set(symbol, {
        symbol,
        category,
        leader: null,
        reason: 'source_disabled',
        candidates,
        hiddenByCollision,
      });
      continue;
    }

    const live = enabled.filter((c) => !runtime.silent.has(c.provider.id));
    const stickyId = runtime.sticky.get(symbol);
    const stickyPick = stickyId ? live.find((c) => c.provider.id === stickyId) : undefined;
    const chosen = stickyPick ?? live[0] ?? enabled[0]!;
    const primaryId = enabled[0]!.provider.id;

    const reason: RouteReason =
      live.length === 0 ? 'silent' : chosen.provider.id === primaryId ? 'primary' : 'failover';
    if (reason === 'failover') failedOver.set(symbol, chosen.provider.id);

    routes.set(symbol, {
      symbol,
      category,
      leader: { providerId: chosen.provider.id, instrument: chosen.instrument },
      reason,
      candidates,
      hiddenByCollision,
    });
    byProvider.get(chosen.provider.id)!.push(chosen.instrument);
  }

  return { routes, byProvider, failedOver };
}

/**
 * Что изменилось между двумя маршрутизациями. `invalidate` — символы, чья
 * цена в памяти **перестала быть ценой от действующего источника**: либо
 * источник сменился, либо его не стало. Их снапшот обязан исчезнуть в момент
 * переключения, а не дожить до порога протухания (ADR-031): иначе оператор
 * выключает источник, а цены от него ещё `staleAfterMs` идут как текущие.
 */
export function diffRouting(
  previous: RoutingTable | null,
  next: RoutingTable,
): { invalidate: string[]; changed: { symbol: string; from: string | null; to: string | null }[] } {
  const changed: { symbol: string; from: string | null; to: string | null }[] = [];
  const invalidate: string[] = [];
  const symbols = new Set<string>([...(previous?.routes.keys() ?? []), ...next.routes.keys()]);
  for (const symbol of symbols) {
    const from = previous?.routes.get(symbol)?.leader?.providerId ?? null;
    const to = next.routes.get(symbol)?.leader?.providerId ?? null;
    if (from === to) continue;
    changed.push({ symbol, from, to });
    // Смена источника и потеря источника — оба делают лежащую цену чужой.
    // Появление источника (from === null) ничего не портит: цены и так нет.
    if (from !== null) invalidate.push(symbol);
  }
  return { invalidate, changed };
}

/** Сводка покрытия. Единица названа в поле `unit` — число без единицы нечестно. */
export interface RoutingSummary {
  unit: 'канонических символов каталога после разрешения коллизий';
  checked: number;
  routed: number;
  byReason: Record<RouteReason, number>;
  byProvider: { providerId: string; symbols: number }[];
  hiddenByCollision: number;
}

export function summarizeRouting(table: RoutingTable): RoutingSummary {
  const byReason: Record<RouteReason, number> = {
    primary: 0,
    failover: 0,
    silent: 0,
    source_disabled: 0,
    no_source: 0,
  };
  let routed = 0;
  let hidden = 0;
  for (const route of table.routes.values()) {
    byReason[route.reason] += 1;
    if (route.leader) routed += 1;
    hidden += route.hiddenByCollision.length;
  }
  return {
    unit: 'канонических символов каталога после разрешения коллизий',
    checked: table.routes.size,
    routed,
    byReason,
    byProvider: [...table.byProvider].map(([providerId, list]) => ({ providerId, symbols: list.length })),
    hiddenByCollision: hidden,
  };
}

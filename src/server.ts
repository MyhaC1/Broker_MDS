import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';

import { buildHealth, buildQuotes, type QuotesRouting, type RegistryHealthInput } from './api.js';
import { groupLabelFor } from './catalog.js';
import { config } from './config.js';
import { QuoteHub } from './hub.js';
import { iconPathFor, iconSvg } from './icons.js';
import { BinanceProvider } from './providers/binance.js';
import { TwelveDataProvider } from './providers/twelvedata.js';
import {
  ADAPTER_KINDS,
  diffRouting,
  resolveRouting,
  summarizeRouting,
  type ProviderEntry,
  type Registry,
  type RouteReason,
  type RoutingTable,
} from './registry.js';
import { saveRegistry, type LoadedRegistry, type RegistryOrigin } from './registry-store.js';
import {
  applyRegistryUpdate,
  AuditLog,
  authorize,
  buildAdminView,
  describeChanges,
  type AdminCode,
} from './admin.js';
import type { CatalogInstrument, Quote } from './types.js';

/**
 * HTTP-обвязка и жизненный цикл источников.
 *
 * Выделено из `index.ts` ради проверяемости, и это не косметика: `index.ts` —
 * скрипт верхнего уровня с `top-level await` и `listen`, импортировать его в
 * тест нельзя. Пока вся проводка жила там, **класс «написано и не
 * вызывается» в ней был непроверяем в принципе** — модульный тест зовёт
 * функцию сам и о том, что её никто не зовёт, узнать не может. Теперь сервер
 * поднимается в тесте целиком, и переключение провайдера проверяется по
 * наблюдаемому следствию, а не по тому, что функция существует.
 */

export interface MdsServerDeps {
  /** Вселенная инструментов: что адаптеры умеют стримить. */
  catalog: CatalogInstrument[];
  /** Откуда каталог: `binance-exchange-info` или `static-fallback`. Уходит наружу. */
  catalogSource: string;
  loaded: LoadedRegistry;
  staleAfterMs: number | null;
  adminToken: string | undefined;
  /** Ключи источников по id. Ключ не покидает MDS, наружу идёт только факт наличия. */
  keys: Map<string, string>;
  now?: () => number;
  /** Период пересчёта маршрутизации (failover по тишине). */
  routingRecheckMs?: number;
  /**
   * Снят ли запрет на правку, меняющую личность ведущего источника (Р-318).
   * Необязателен **только для тестов**; боевой запуск передаёт его из
   * конфигурации, и умолчание здесь — запрещено, а не разрешено.
   */
  allowRoutingIdentityChange?: boolean;
  /** Не создавать живых адаптеров: для тестов проводки без сети. */
  providerFactory?: ProviderFactory;
}

export interface RunningProvider {
  id: string;
  adapter: string;
  readonly lastTickAt: number;
  setInstruments(instruments: CatalogInstrument[]): void;
  stop(): void;
}

export type ProviderFactory = (
  entry: ProviderEntry,
  key: string | undefined,
  onQuote: (q: Quote) => void,
) => RunningProvider | null;

const MAX_BODY_BYTES = 64 * 1024;

function defaultProviderFactory(
  entry: ProviderEntry,
  key: string | undefined,
  onQuote: (q: Quote) => void,
): RunningProvider | null {
  // Проверки «нужен ключ, а ключа нет» здесь НЕТ сознательно: она живёт в
  // `syncProviders`. Две проверки одного свойства на одном пути маскируют
  // смерть одной из них, а подменный завод в тестах обошёл бы эту.
  if (entry.adapter === 'binance') {
    const provider = new BinanceProvider(onQuote, { id: entry.id });
    provider.connect();
    return {
      id: entry.id,
      adapter: entry.adapter,
      get lastTickAt() {
        return provider.lastTickAt;
      },
      setInstruments: (list) => provider.setInstruments(list),
      stop: () => provider.stop(),
    };
  }

  const provider = new TwelveDataProvider(onQuote, {
    id: entry.id,
    apiKey: key ?? '',
    apiUrl: config.twelveData.apiUrl,
    creditsPerMin: config.twelveData.creditsPerMin,
    creditsPerDay: config.twelveData.creditsPerDay,
  });
  return {
    id: entry.id,
    adapter: entry.adapter,
    get lastTickAt() {
      return provider.lastTickAt;
    },
    setInstruments: (list) => {
      provider.setInstruments(list);
      provider.connect();
    },
    stop: () => provider.stop(),
  };
}

export interface MdsServer {
  httpServer: HttpServer;
  hub: QuoteHub;
  /** Применить реестр: пересчитать маршруты, переназначить источники, забыть чужие цены. */
  applyRegistry(registry: Registry, origin: RegistryOrigin): ApplyResult;
  routing(): RoutingTable | null;
  registry(): Registry | null;
  /**
   * Сколько тиков отброшено фильтром провенанса: пришли от источника,
   * который этот символ не ведёт. Счётчик, а не тишина — молчаливый пропуск
   * и есть способ, которым расхождение живёт годами.
   */
  shadowedTicks(): number;
  /** Пересчёт маршрутизации по тишине источников. Возвращает применённый результат. */
  recheck(): ApplyResult | null;
  audit: AuditLog;
  close(): void;
}

export interface ApplyResult {
  invalidated: number;
  changed: { symbol: string; from: string | null; to: string | null }[];
  started: string[];
  stopped: string[];
  /** Включённые источники, которым нужен ключ, а ключа нет. */
  missingKeys: string[];
}

export function createMdsServer(deps: MdsServerDeps): MdsServer {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const audit = new AuditLog();

  let registry: Registry | null = deps.loaded.registry;
  let origin: RegistryOrigin = deps.loaded.origin;
  let loadError: string | undefined = deps.loaded.error;
  let table: RoutingTable | null = null;
  let missingKeys: string[] = [];

  const sticky = new Map<string, string>();
  const running = new Map<string, RunningProvider>();
  /** Когда источник был запущен: до первого тика тишину считаем от запуска. */
  const providerStartedAt = new Map<string, number>();
  const factory = deps.providerFactory ?? defaultProviderFactory;

  const httpServer = createServer((req, res) => handle(req, res));
  const hub = new QuoteHub(httpServer, { staleAfterMs: deps.staleAfterMs, now });

  /**
   * Тик от источника. **Единственное место, где цена попадает в снапшот**, и
   * здесь же стоит фильтр провенанса: тик от источника, который этот символ
   * не ведёт, в хаб не проходит. Без фильтра запасной источник, оставшийся
   * подписанным, продолжал бы перебивать ведущего — и цена менялась бы
   * источником, которого никто не выбирал.
   */
  let shadowed = 0;
  function onQuote(providerId: string, quote: Quote): void {
    const leader = table?.routes.get(quote.symbol)?.leader?.providerId;
    if (leader !== providerId) {
      shadowed += 1;
      return;
    }
    hub.push(quote);
  }

  /**
   * Источники, которые заведомо не могут дать цену: включены, требуют ключ,
   * ключа нет. Это **статическое знание** из реестра и окружения, и считать
   * его надо ДО маршрутизации — иначе на первом круге, когда не запущен ещё
   * никто, «не запущен» неотличимо от «отказал», и выбор запасного
   * откладывается до следующего пересчёта.
   */
  function providersWithoutKey(reg: Registry | null): string[] {
    return (reg?.providers ?? [])
      .filter((p) => p.enabled && p.requiresKey && (deps.keys.get(p.id) ?? '') === '')
      .map((p) => p.id);
  }

  /**
   * Источники, молчащие дольше собственного порога.
   *
   * Судится только то, о чём есть знание: источник, которому ничего не
   * назначено, молчит **потому что ему нечего передавать**. Считать его
   * молчащим значило бы сделать failover невозможным в принципе —
   * единственный живой запасной всегда выглядел бы мёртвым. Отсутствие
   * события здесь означает отсутствие знания, а не отказ.
   */
  function silentByTime(): Set<string> {
    const at = now();
    const silent = new Set<string>();
    for (const entry of registry?.providers ?? []) {
      if (!entry.enabled) continue;
      if (entry.maxSilenceMs === null) continue; // поллер: молчание штатно
      const provider = running.get(entry.id);
      if (!provider) continue;
      if ((table?.byProvider.get(entry.id)?.length ?? 0) === 0) continue;
      const since = Math.max(provider.lastTickAt, providerStartedAt.get(entry.id) ?? at);
      if (at - since > entry.maxSilenceMs) silent.add(entry.id);
    }
    return silent;
  }

  function silentProviders(reg: Registry | null = registry): Set<string> {
    return new Set([...providersWithoutKey(reg), ...silentByTime()]);
  }

  function syncProviders(next: RoutingTable, current: Registry): { started: string[]; stopped: string[] } {
    const started: string[] = [];
    const stopped: string[] = [];
    const wanted = new Map(current.providers.filter((p) => p.enabled).map((p) => [p.id, p]));

    for (const [id, provider] of running) {
      if (wanted.has(id)) continue;
      provider.stop();
      running.delete(id);
      providerStartedAt.delete(id);
      stopped.push(id);
    }

    // Источник без ключа не запускается вовсе, и список таких посчитан до
    // маршрутизации — см. providersWithoutKey.
    const noKey = new Set(missingKeys);
    for (const [id, entry] of wanted) {
      if (noKey.has(id)) continue;
      const key = deps.keys.get(id) ?? '';
      let provider = running.get(id);
      if (!provider) {
        const created = factory(entry, key, (quote) => onQuote(id, quote));
        if (!created) {
          // Завод отказался создать адаптер — состояние не «молчит», а
          // «не запущен», и наружу оно идёт тем же списком.
          missingKeys.push(id);
          continue;
        }
        provider = created;
        running.set(id, provider);
        providerStartedAt.set(id, now());
        started.push(id);
      }
      provider.setInstruments(next.byProvider.get(id) ?? []);
    }
    return { started, stopped };
  }

  function applyRegistry(next: Registry, nextOrigin: RegistryOrigin): ApplyResult {
    registry = next;
    origin = nextOrigin;
    loadError = undefined;
    missingKeys = providersWithoutKey(next);
    const resolved = resolveRouting(deps.catalog, next, { silent: silentProviders(next), sticky });
    const { invalidate, changed } = diffRouting(table, resolved);
    table = resolved;
    announceMultiCandidate(resolved);
    sticky.clear();
    for (const [symbol, providerId] of resolved.failedOver) sticky.set(symbol, providerId);

    const { started, stopped } = syncProviders(resolved, next);
    // Цены символов, сменивших или потерявших источник, забываются немедленно
    // (ADR-031): дожить до порога протухания им нельзя — это были бы
    // `staleAfterMs` чужой цены, выдаваемой за текущую.
    const invalidated = hub.invalidate(invalidate);
    if (changed.length > 0) {
      console.info(
        `[mds] маршрутизация: ${changed.length} символов сменили источник, забыто цен ${invalidated}` +
          (started.length ? `, запущено [${started.join(',')}]` : '') +
          (stopped.length ? `, остановлено [${stopped.join(',')}]` : ''),
      );
    }
    return { invalidated, changed, started, stopped, missingKeys: [...missingKeys] };
  }

  /**
   * Тревога на число символов с двумя и более кандидатами (Р-317).
   *
   * **Зачем она, если есть запрет.** Запрет закрывает служебную ручку, но
   * реестр меняется не только ей: он читается из файла на старте, и при
   * невыданном `MDS_ADMIN_TOKEN` правка файла — штатный и единственный путь.
   * Отказать на старте нельзя — это значит остановить котировки из-за
   * правки, которая уже сделана. Поэтому здесь не отказ, а крик: стартуем и
   * кричим.
   *
   * Кричим **на переходе**, а не на каждом пересчёте: пересчёт идёт раз в
   * `routingRecheckMs`, и тревога, повторяемая каждые пять секунд, перестаёт
   * читаться на второй минуте. Возврат к нулю объявляется тоже — иначе
   * «починили» неотличимо от «перестали смотреть».
   */
  let lastMultiCandidate: number | null = null;
  function announceMultiCandidate(next: RoutingTable): void {
    const value = summarizeRouting(next).multiCandidate;
    if (value === lastMultiCandidate) return;
    const was = lastMultiCandidate;
    lastMultiCandidate = value;
    if (value > 0) {
      console.warn(
        `[mds] ТРЕВОГА: у ${value} символов больше одного кандидата в источники ` +
          `(было ${was ?? 'не считано'}). Смена источника на живом символе стала возможна, ` +
          'а потребитель показывает её очередным тиком — скачком цены как движением рынка. ' +
          'Пока витрина не умеет показывать разрыв ряда, второй источник на категорию включать нельзя.',
      );
    } else if (was !== null && was > 0) {
      console.info('[mds] тревога снята: у каждого символа снова ровно один кандидат в источники.');
    }
  }

  function recheck(): ApplyResult | null {
    if (!registry) return null;
    missingKeys = providersWithoutKey(registry);
    const resolved = resolveRouting(deps.catalog, registry, { silent: silentProviders(), sticky });
    const { invalidate, changed } = diffRouting(table, resolved);
    if (changed.length === 0) return null;
    table = resolved;
    announceMultiCandidate(resolved);
    for (const [symbol, providerId] of resolved.failedOver) sticky.set(symbol, providerId);
    const { started, stopped } = syncProviders(resolved, registry);
    const invalidated = hub.invalidate(invalidate);
    console.warn(
      `[mds] failover по тишине источника: ${changed.length} символов сменили источник, забыто цен ${invalidated}`,
    );
    return { invalidated, changed, started, stopped, missingKeys: [...missingKeys] };
  }

  if (registry) applyRegistry(registry, origin);
  else {
    console.error(
      `[mds] реестр провайдеров не прочитан (${loadError ?? 'причина не названа'}) — ` +
        'источники НЕ ЗАПУЩЕНЫ, котировок нет. Умолчание здесь не подставляется ' +
        'сознательно: цены из источников, которых никто не выбирал, хуже их отсутствия.',
    );
  }

  const recheckTimer = setInterval(() => recheck(), deps.routingRecheckMs ?? config.routingRecheckMs);
  recheckTimer.unref?.();

  /* ---------------------------------------------------------------- */
  /* HTTP                                                              */
  /* ---------------------------------------------------------------- */

  function registryHealth(): RegistryHealthInput {
    const silent = silentProviders();
    const summary = table ? summarizeRouting(table) : null;
    return {
      origin,
      ...(loadError === undefined ? {} : { error: loadError }),
      version: registry?.version ?? null,
      providers: (registry?.providers ?? []).map((p) => ({
        id: p.id,
        enabled: p.enabled,
        silent: silent.has(p.id),
      })),
      // `null`, а не `0`: таблицы маршрутизации нет — значит мы не
      // считали, а не насчитали ноль. То же, что `coverage: null` у
      // `/v1/instruments` (QA-05: два ответа про одну величину
      // обязаны говорить одинаково).
      routed: summary === null ? null : summary.routed,
      checked: summary === null ? null : summary.checked,
      multiCandidate: summary === null ? null : summary.multiCandidate,
      missingKeys: [...missingKeys],
    };
  }

  function quotesRouting(): QuotesRouting {
    const reasons = new Map<string, RouteReason>();
    if (!table) return { readable: false, reasons };
    for (const [symbol, route] of table.routes) reasons.set(symbol, route.reason);
    return { readable: true, reasons };
  }

  function json(res: ServerResponse, status: number, body: unknown, noStore = false): void {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(noStore ? { 'Cache-Control': 'no-store' } : {}),
    });
    res.end(JSON.stringify(body));
  }

  /**
   * Тело отказа. Код берётся из `ADMIN_CODES` — перечня, который видно в
   * рантайме, а не из строки на месте: перечень, который ведут руками рядом
   * с кодом, отстаёт молча, и стиль в нём расходится незаметно (Р-087).
   */
  function jsonError(
    res: ServerResponse,
    status: number,
    code: AdminCode,
    detail?: string,
    noStore = false,
  ): void {
    json(res, status, { error: code, ...(detail === undefined ? {} : { detail }) }, noStore);
  }

  async function readBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return { ok: false, detail: `тело больше ${MAX_BODY_BYTES} байт` };
      chunks.push(chunk as Buffer);
    }
    try {
      return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch (error) {
      return { ok: false, detail: `JSON: ${(error as Error).message}` };
    }
  }

  function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL): void {
    // На служебных путях CORS-заголовка нет вовсе, а preflight отбивается:
    // ручка управления — сервер-серверная, и из браузера её звать нельзя.
    if (req.method === 'OPTIONS') {
      jsonError(res, 405, 'method-not-allowed', 'служебная ручка только сервер-сервером', true);
      return;
    }
    const auth = authorize(req.headers['x-mds-admin-token'], deps.adminToken);
    if (!auth.ok) {
      json(res, auth.status, { error: auth.code, detail: auth.detail }, true);
      return;
    }

    const remote = req.socket.remoteAddress ?? 'unknown';

    if (url.pathname === '/v1/admin/audit' && req.method === 'GET') {
      json(res, 200, { entries: audit.list() }, true);
      return;
    }
    if (url.pathname !== '/v1/admin/providers') {
      jsonError(res, 404, 'not-found', undefined, true);
      return;
    }

    if (req.method === 'GET') {
      json(
        res,
        200,
        buildAdminView({
          registry,
          origin,
          ...(loadError === undefined ? {} : { error: loadError }),
          adapters: ADAPTER_KINDS,
          routing: table,
          keyPresence: new Map(
            (registry?.providers ?? []).map((p) => [p.id, (deps.keys.get(p.id) ?? '') !== '']),
          ),
        }),
        true,
      );
      return;
    }

    if (req.method !== 'PUT') {
      jsonError(res, 405, 'method-not-allowed', undefined, true);
      return;
    }

    void readBody(req).then((body) => {
      if (!body.ok) {
        audit.record({
          at: new Date(now()).toISOString(),
          actor: 'unknown',
          remote,
          outcome: 'rejected:bad-body',
          fromVersion: registry?.version ?? null,
          toVersion: null,
          changes: [body.detail],
        });
        jsonError(res, 400, 'bad-body', body.detail, true);
        return;
      }
      const actor =
        typeof (body.value as Record<string, unknown>)?.updatedBy === 'string'
          ? String((body.value as Record<string, unknown>).updatedBy).slice(0, 120)
          : 'unnamed';
      const outcome = applyRegistryUpdate(
        registry,
        body.value,
        { now: new Date(now()), actor },
        {
          catalog: deps.catalog,
          allowIdentityChange: deps.allowRoutingIdentityChange ?? false,
        },
      );
      if (!outcome.ok) {
        audit.record({
          at: new Date(now()).toISOString(),
          actor,
          remote,
          outcome: `rejected:${outcome.code}`,
          fromVersion: registry?.version ?? null,
          toVersion: null,
          changes: [outcome.detail],
        });
        json(res, outcome.status, { error: outcome.code, detail: outcome.detail }, true);
        return;
      }

      const changes = describeChanges(registry, outcome.registry);
      let persisted = true;
      let persistError: string | undefined;
      try {
        saveRegistry(deps.loaded.path, outcome.registry);
      } catch (error) {
        persisted = false;
        persistError = (error as Error).message;
      }
      const effect = applyRegistry(outcome.registry, 'file');
      audit.record({
        at: new Date(now()).toISOString(),
        actor,
        remote,
        outcome: persisted ? 'applied' : 'applied-not-persisted',
        fromVersion: outcome.registry.version - 1,
        toVersion: outcome.registry.version,
        changes: [
          ...changes,
          `символов сменили источник: ${effect.changed.length}, забыто цен: ${effect.invalidated}`,
          ...(persisted ? [] : [`НЕ СОХРАНЁН НА ДИСК: ${persistError}`]),
        ],
      });
      json(
        res,
        persisted ? 200 : 207,
        {
          registry: outcome.registry,
          applied: effect,
          // Правка, принятая в память и не записанная на диск, переживёт
          // ровно до рестарта. Это обязано быть видно в ответе, а не только
          // в логе: иначе админка покажет успех, а после деплоя настройка
          // молча вернётся к прежней.
          persisted,
          ...(persisted ? {} : { persistError }),
        },
        true,
      );
    });
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://mds');

    if (url.pathname.startsWith('/v1/admin/')) {
      handleAdmin(req, res, url);
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (url.pathname === '/health') {
      const leaderOf = new Map<string, string>();
      for (const [symbol, route] of table?.routes ?? []) {
        if (route.leader) leaderOf.set(symbol, route.leader.providerId);
      }
      const { httpStatus, body } = buildHealth({
        ages: hub.ages(),
        providers: [...running.values()].map((p) => ({ name: p.id, lastTickAt: p.lastTickAt })),
        providerOf: leaderOf,
        primaryProvider: registry?.providers.find((p) => p.enabled)?.id ?? '(нет включённых)',
        staleAfterMs: deps.staleAfterMs,
        catalog: { source: deps.catalogSource, instruments: deps.catalog.length },
        registry: registryHealth(),
        clients: hub.clientCount,
        startedAt,
        now: now(),
      });
      json(res, httpStatus, body);
      return;
    }

    if (url.pathname === '/v1/instruments') {
      // Каталог обязан называть себя: именно здесь штаб однажды принял 33
      // инструмента запасного каталога за живые 500. Поле `catalogSource`
      // стоит в самом ответе, а не только в `/health`, потому что читают
      // этот ответ, а не соседний.
      const items = [...(table?.routes.values() ?? [])]
        .filter((route) => route.leader !== null)
        .map((route) => {
          const i = route.leader!.instrument;
          return {
            ...i,
            provider: route.leader!.providerId,
            icon: iconPathFor(i.symbol),
            group: groupLabelFor(i),
          };
        });
      const summary = table ? summarizeRouting(table) : null;
      json(res, table ? 200 : 503, {
        items,
        catalogSource: deps.catalogSource,
        isFallbackCatalog: deps.catalogSource === 'static-fallback',
        registry: { origin, version: registry?.version ?? null },
        coverage: summary,
        ...(table
          ? {}
          : { error: 'registry-unreadable', detail: loadError ?? 'реестр провайдеров не прочитан' }),
      });
      return;
    }

    const iconMatch = url.pathname.match(/^\/icons\/([A-Z0-9]{1,20})\.svg$/);
    if (iconMatch) {
      const svg = iconSvg(iconMatch[1]!);
      if (svg) {
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=86400, immutable',
        });
        res.end(svg);
      } else {
        jsonError(res, 404, 'not-found');
      }
      return;
    }

    if (url.pathname === '/v1/quotes') {
      const requested = url.searchParams.get('symbols')?.split(',').filter(Boolean) ?? null;
      json(
        res,
        200,
        buildQuotes(hub.snapshot(requested ?? undefined), deps.staleAfterMs, quotesRouting(), requested),
      );
      return;
    }

    jsonError(res, 404, 'not-found');
  }

  return {
    httpServer,
    hub,
    applyRegistry,
    routing: () => table,
    registry: () => registry,
    shadowedTicks: () => shadowed,
    recheck,
    audit,
    close() {
      clearInterval(recheckTimer);
      for (const provider of running.values()) provider.stop();
      running.clear();
      httpServer.close();
    },
  };
}

import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinRegistry, type ProviderEntry, type Registry } from './registry.js';
import { loadRegistry } from './registry-store.js';
import { createMdsServer, type MdsServer, type RunningProvider } from './server.js';
import type { CatalogInstrument, Quote } from './types.js';

/**
 * **Интеграционный набор.** Сервер поднимается целиком, ручки зовутся по
 * HTTP, провайдеры подменены двойниками. Нужен он не для полноты: класс
 * «написано и не вызывается» модульными тестами не ловится **в принципе** —
 * модульный тест зовёт функцию сам. Именно против этого набора прогоняются
 * мутации на проводку (см. `docs/Тесты и смоук.md`).
 *
 * Двойник провайдера намеренно НЕ повторяет сетевой адаптер: он отдаёт
 * ручку, которой тест подаёт тик, и запоминает, какие инструменты ему
 * назначили. Двойник, верный контракту по сигнатурам, но ведущий учёт вместо
 * работы, — самая дорогая разновидность подделки, поэтому здесь проверяется
 * наблюдаемое следствие (что ушло в снапшот), а не вызовы двойника.
 */

// Секрет едет HTTP-заголовком: только ASCII. Это ограничение проверяется
// отдельным тестом ниже — поймано живым прогоном, а не чтением кода.
const TOKEN = 'mds-admin-token-dostatochnoy-dliny';
const STALE_AFTER = 30_000;

function instrument(symbol: string, provider: string, category: Quote['category'] = 'crypto'): CatalogInstrument {
  return {
    symbol,
    name: symbol,
    category,
    segment: null,
    digits: 2,
    provider: provider as CatalogInstrument['provider'],
    providerSymbol: symbol.toLowerCase(),
  };
}

const CATALOG: CatalogInstrument[] = [
  instrument('BTCUSD', 'binance'),
  instrument('XAUUSD', 'twelvedata', 'metals'),
  instrument('XAUUSD', 'metals-alt', 'metals'),
];

/** Реестр с настоящим вторым источником на один символ. */
function twoSourceRegistry(): Registry {
  const base = builtinRegistry();
  const alt: ProviderEntry = {
    id: 'metals-alt',
    adapter: 'twelvedata',
    label: 'Запасной источник металлов',
    enabled: true,
    priority: 30,
    covers: ['metals'],
    maxSilenceMs: 60_000,
    requiresKey: false,
  };
  return {
    ...base,
    providers: [
      base.providers[0]!,
      // maxSilenceMs задан намеренно: иначе это поллер, чьё молчание штатно,
      // и сценарий failover по тишине к нему неприменим (см. отдельный тест).
      { ...base.providers[1]!, enabled: true, requiresKey: false, maxSilenceMs: 60_000 },
      alt,
    ],
  };
}

interface Harness {
  server: MdsServer;
  base: string;
  /** Подать тик от имени источника — как если бы он прилетел из сети. */
  tick(providerId: string, symbol: string, price: number, ts?: number): void;
  /** Что сейчас назначено источнику. */
  assigned(providerId: string): string[];
  setClock(ms: number): void;
  stopTicking(providerId: string): void;
}

const live: Harness[] = [];

afterEach(() => {
  for (const h of live.splice(0)) h.server.close();
});

async function boot(options: {
  registry?: Registry;
  registryPath?: string;
  origin?: 'file' | 'builtin-default' | 'error';
  error?: string;
  adminToken?: string | undefined;
  staleAfterMs?: number | null;
  keys?: Map<string, string>;
  catalogSource?: string;
}): Promise<Harness> {
  let clock = 1_800_000_000_000;
  const emitters = new Map<string, (q: Quote) => void>();
  const assignments = new Map<string, string[]>();
  const lastTick = new Map<string, number>();

  const path = options.registryPath ?? join(mkdtempSync(join(tmpdir(), 'mds-srv-')), 'providers.json');
  const registry = options.registry ?? twoSourceRegistry();
  const origin = options.origin ?? 'file';

  const server = createMdsServer({
    catalog: CATALOG,
    catalogSource: options.catalogSource ?? 'binance-exchangeInfo',
    loaded:
      origin === 'error'
        ? { origin: 'error', registry: null, error: options.error ?? 'JSON: сломан', path }
        : { origin, registry, path },
    staleAfterMs: options.staleAfterMs === undefined ? STALE_AFTER : options.staleAfterMs,
    adminToken: 'adminToken' in options ? options.adminToken : TOKEN,
    keys: options.keys ?? new Map(),
    now: () => clock,
    routingRecheckMs: 1_000_000, // пересчёт зовём руками, чтобы не ловить гонку
    providerFactory: (entry, _key, onQuote): RunningProvider | null => {
      emitters.set(entry.id, onQuote);
      lastTick.set(entry.id, clock);
      return {
        id: entry.id,
        adapter: entry.adapter,
        get lastTickAt() {
          return lastTick.get(entry.id) ?? 0;
        },
        setInstruments: (list) => assignments.set(entry.id, list.map((i) => i.symbol)),
        stop: () => {
          emitters.delete(entry.id);
          assignments.delete(entry.id);
        },
      };
    },
  });

  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address() as AddressInfo;

  const harness: Harness = {
    server,
    base: `http://127.0.0.1:${port}`,
    tick(providerId, symbol, price, ts) {
      const emit = emitters.get(providerId);
      if (!emit) throw new Error(`источник ${providerId} не запущен — тик подавать некому`);
      lastTick.set(providerId, clock);
      const entry = CATALOG.find((i) => i.symbol === symbol && i.provider === providerId)!;
      emit({
        symbol,
        name: entry.name,
        category: entry.category,
        price,
        digits: entry.digits,
        changePercent: 0,
        ts: ts ?? clock,
        source: providerId,
      });
    },
    assigned: (providerId) => assignments.get(providerId) ?? [],
    setClock: (ms) => {
      clock = ms;
    },
    stopTicking: (providerId) => lastTick.set(providerId, 0),
  };
  live.push(harness);
  return harness;
}

/**
 * Тело ответа как данные. `Response.json()` типизирован `unknown`, и это
 * правильно: проверяем мы форму ответа, а не свои же типы — утверждать тут
 * тип означало бы проверять собственное представление о контракте.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

async function asJson(res: Response): Promise<Body> {
  return res.json();
}

function admin(h: Harness, init: RequestInit & { token?: string | null } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers['X-MDS-Admin-Token'] = token;
  return fetch(`${h.base}/v1/admin/providers`, { ...init, headers });
}

describe('служебная ручка · кто имеет право её звать', () => {
  it('секрет не задан → 503 «ручка выключена», а НЕ открытая ручка', async () => {
    const h = await boot({ adminToken: undefined });
    const res = await admin(h, { token: null });
    expect(res.status).toBe(503);
    expect((await asJson(res)).error).toBe('control_plane_disabled');
  });

  it('секрет короткий → тоже 503: видимость защиты защитой не считается', async () => {
    const h = await boot({ adminToken: 'korotko' });
    expect((await admin(h, { token: 'korotko' })).status).toBe(503);
  });

  it('секрет не-ASCII → 503 «непередаваем в заголовке», а не вечный 401', async () => {
    // Иначе настройка выглядит рабочей, клиент не может её даже прислать, а
    // диагноз «секрет неверный» отправляет чинить не то.
    const h = await boot({ adminToken: 'секрет-достаточной-длины-для-ручки' });
    const res = await fetch(`${h.base}/v1/admin/providers`);
    expect(res.status).toBe(503);
    expect((await asJson(res)).detail).toContain('ASCII');
  });

  it('«ручка выключена» и «вас не пустили» — разные коды, их чинят по-разному', async () => {
    const off = await boot({ adminToken: undefined });
    const on = await boot({});
    expect((await admin(off, { token: null })).status).toBe(503);
    expect((await admin(on, { token: null })).status).toBe(401);
  });

  it('нет заголовка → 401 no_token, чужой секрет → 401 bad_token', async () => {
    const h = await boot({});
    expect((await asJson(await admin(h, { token: null }))).detail).toBe('no_token');
    expect((await asJson(await admin(h, { token: 'ne-tot-sekret-dlinoyu-podlinnee' }))).detail).toBe(
      'bad_token',
    );
  });

  it('из браузера не дотянуться: preflight отбит и CORS-заголовка на ручке нет', async () => {
    const h = await boot({});
    const options = await fetch(`${h.base}/v1/admin/providers`, { method: 'OPTIONS' });
    expect(options.status).toBe(405);
    const get = await admin(h);
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
    // На котировках звёздочка остаётся — это другая граница (MDS-04b).
    const health = await fetch(`${h.base}/health`);
    expect(health.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('правильный секрет → реестр и перечень доступных адаптеров', async () => {
    const h = await boot({});
    const body = await asJson(await admin(h));
    expect(body.registry.providers).toHaveLength(3);
    expect(body.adapters).toEqual(['binance', 'twelvedata']);
    expect(body.origin).toBe('file');
  });

  it('ключи наружу не отдаются — только факт наличия', async () => {
    const h = await boot({ keys: new Map([['twelvedata', 'очень-секретный-ключ']]) });
    const raw = await (await admin(h)).text();
    expect(raw).not.toContain('очень-секретный-ключ');
    expect(JSON.parse(raw).keys).toContainEqual({ providerId: 'twelvedata', required: false, present: true });
  });
});

describe('служебная ручка · приём изменения', () => {
  async function put(h: Harness, body: unknown, token?: string | null) {
    return admin(h, { method: 'PUT', body: JSON.stringify(body), ...(token === undefined ? {} : { token }) });
  }

  it('версия не совпала → 409, правка чужой версии не затирает текущую', async () => {
    const h = await boot({});
    const res = await put(h, { ...twoSourceRegistry(), version: 99 });
    expect(res.status).toBe(409);
    expect((await asJson(res)).error).toBe('version_conflict');
    expect(h.server.registry()?.version).toBe(0);
  });

  it('версии нет вовсе → 400: без неё правка затирает чужую молча', async () => {
    const h = await boot({});
    const { version: _drop, ...noVersion } = twoSourceRegistry();
    expect((await put(h, noVersion)).status).toBe(400);
  });

  it('незнакомое поле → 400, а не молча отброшенная настройка', async () => {
    const h = await boot({});
    const res = await put(h, { ...twoSourceRegistry(), опечатка: true });
    expect(res.status).toBe(400);
    expect((await asJson(res)).error).toBe('invalid_registry');
  });

  it('принятая правка поднимает версию и ложится на диск', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mds-persist-'));
    const path = join(dir, 'providers.json');
    const h = await boot({ registryPath: path });
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    const res = await put(h, next);
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.registry.version).toBe(1);
    expect(body.persisted).toBe(true);
    // Переживает рестарт: иначе переключатель работает до первого деплоя.
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
    expect(loadRegistry(path).registry?.providers.find((p) => p.id === 'binance')?.enabled).toBe(false);
  });

  it('изменение попадает в журнал с «с чего на что», отказ — тоже', async () => {
    const h = await boot({});
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    await put(h, { ...next, updatedBy: 'админка CMS' });
    await put(h, { ...next, version: 77 });
    const entries = h.server.audit.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.outcome).toBe('applied');
    expect(entries[0]?.actor).toBe('админка CMS');
    expect(entries[0]?.changes.join(' ')).toContain('binance: enabled true → false');
    expect(entries[1]?.outcome).toBe('rejected:version_conflict');
  });

  it('реестр не прочитан → правку не принимаем вслепую (503), а не пишем поверх', async () => {
    const h = await boot({ origin: 'error' });
    const res = await put(h, twoSourceRegistry());
    expect(res.status).toBe(503);
    expect((await asJson(res)).error).toBe('registry_unreadable');
  });
});

describe('переключение провайдера · что происходит с ценой под сделками', () => {
  it('источник выключили → его цена исчезает НЕМЕДЛЕННО, а не доживает до порога', async () => {
    // Это главный тест задачи. Цена свежая (возраст 0 при пороге 30 с):
    // без инвалидации она отдавалась бы как текущая ещё полпорога после
    // того, как оператор источник выключил.
    const h = await boot({});
    h.tick('binance', 'BTCUSD', 70_000);
    const before = await asJson(await fetch(`${h.base}/v1/quotes?symbols=BTCUSD`));
    expect(before.items[0]?.price).toBe(70_000);
    expect(before.items[0]?.source).toBe('binance');

    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    const applied = await asJson(await admin(h, { method: 'PUT', body: JSON.stringify(next) }));
    expect(applied.applied.invalidated).toBe(1);

    const after = await asJson(await fetch(`${h.base}/v1/quotes?symbols=BTCUSD`));
    expect(after.items).toEqual([]);
    // И отказ назван, а не выглядит как «пока не приехало».
    expect(after.unavailable).toEqual([{ symbol: 'BTCUSD', reason: 'source_disabled' }]);
  });

  it('смена ведущего источника стирает цену прежнего, а не продолжает ею ряд', async () => {
    const h = await boot({});
    h.tick('twelvedata', 'XAUUSD', 2_400);
    expect((await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`))).items[0]?.source).toBe(
      'twelvedata',
    );

    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) =>
      p.id === 'metals-alt' ? { ...p, priority: 5 } : p,
    );
    await admin(h, { method: 'PUT', body: JSON.stringify(next) });

    const after = await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`));
    expect(after.items).toEqual([]);
    expect(after.unavailable).toEqual([{ symbol: 'XAUUSD', reason: 'source_silent' }]);
    // И трансляция переехала на нового ведущего, а не осталась на бумаге.
    expect(h.assigned('metals-alt')).toEqual(['XAUUSD']);
    expect(h.assigned('twelvedata')).toEqual([]);
  });

  it('тик от источника, который символ не ведёт, в снапшот не проходит', async () => {
    // Запасной, оставшийся подписанным, иначе перебивал бы ведущего — цена
    // менялась бы источником, которого никто не выбирал.
    const h = await boot({});
    h.tick('twelvedata', 'XAUUSD', 2_400);
    h.tick('metals-alt', 'XAUUSD', 2_999);
    const body = await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`));
    expect(body.items[0]?.price).toBe(2_400);
    expect(body.items[0]?.source).toBe('twelvedata');
    expect(h.server.shadowedTicks()).toBe(1);
  });

  it('поллер молчит часами и это НЕ failover: его молчание объявлено штатным', async () => {
    // maxSilenceMs: null — не забытое поле, а утверждение «молчание этого
    // источника отказом не является». Таймер тишины, применённый к поллеру,
    // устроил бы вечное переключение на ровном месте.
    const reg = twoSourceRegistry();
    reg.providers = reg.providers.map((p) => (p.id === 'twelvedata' ? { ...p, maxSilenceMs: null } : p));
    const h = await boot({ registry: reg });
    h.tick('twelvedata', 'XAUUSD', 2_400);
    h.stopTicking('twelvedata');
    h.setClock(1_800_000_000_000 + 6 * 3_600_000);
    expect(h.server.recheck()).toBeNull();
    expect(h.server.routing()?.routes.get('XAUUSD')?.leader?.providerId).toBe('twelvedata');
  });

  it('выключенный источник остановлен, а не продолжает слать в пустоту', async () => {
    const h = await boot({});
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    const res = await asJson(await admin(h, { method: 'PUT', body: JSON.stringify(next) }));
    expect(res.applied.stopped).toEqual(['binance']);
    expect(() => h.tick('binance', 'BTCUSD', 1)).toThrow(/не запущен/);
  });

  it('молчание ведущего дольше его порога → failover на запасного, цена прежнего забыта', async () => {
    const h = await boot({});
    h.tick('twelvedata', 'XAUUSD', 2_400);
    h.stopTicking('twelvedata');
    h.setClock(1_800_000_000_000 + 120_000);

    const effect = h.server.recheck();
    expect(effect?.changed).toEqual([{ symbol: 'XAUUSD', from: 'twelvedata', to: 'metals-alt' }]);
    expect(h.assigned('metals-alt')).toEqual(['XAUUSD']);
    const body = await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`));
    expect(body.items).toEqual([]);

    // Новый источник наполняет символ заново и уже своим провенансом.
    h.tick('metals-alt', 'XAUUSD', 2_412);
    const after = await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`));
    expect(after.items[0]).toMatchObject({ price: 2_412, source: 'metals-alt' });
  });
});

describe('состояния, которые нельзя путать, видны снаружи', () => {
  it('реестр не прочитан: /health 503, инструменты 503, котировки с причиной', async () => {
    const h = await boot({ origin: 'error', error: 'JSON: сломан на 3 строке' });
    const health = await fetch(`${h.base}/health`);
    expect(health.status).toBe(503);
    expect((await asJson(health)).reason).toContain('не прочитан');

    const instruments = await fetch(`${h.base}/v1/instruments`);
    expect(instruments.status).toBe(503);
    const body = await asJson(instruments);
    expect(body.items).toEqual([]);
    expect(body.error).toBe('registry_unreadable');

    const quotes = await asJson(await fetch(`${h.base}/v1/quotes?symbols=BTCUSD`));
    expect(quotes.unavailable).toEqual([{ symbol: 'BTCUSD', reason: 'registry_unreadable' }]);
  });

  it('реестр не прочитан → источники не запущены вовсе', async () => {
    const h = await boot({ origin: 'error' });
    expect(() => h.tick('binance', 'BTCUSD', 1)).toThrow(/не запущен/);
  });

  it('пустой реестр отличим от нечитаемого: 200 с пустым списком и причиной', async () => {
    const h = await boot({ registry: { ...builtinRegistry(), providers: [] } });
    const instruments = await asJson(await fetch(`${h.base}/v1/instruments`));
    expect(instruments.items).toEqual([]);
    expect(instruments.coverage.checked).toBe(2);
    expect(instruments.coverage.routed).toBe(0);
    const health = await asJson(await fetch(`${h.base}/health`));
    expect(health.reason).toContain('пуст');
  });

  it('запасной каталог называет себя запасным в самом ответе, а не в соседнем', async () => {
    // 33 инструмента запасного каталога уже были однажды приняты за живые 500.
    const h = await boot({ catalogSource: 'static-fallback' });
    const body = await asJson(await fetch(`${h.base}/v1/instruments`));
    expect(body.catalogSource).toBe('static-fallback');
    expect(body.isFallbackCatalog).toBe(true);
  });

  it('живой каталог себя запасным не называет', async () => {
    const h = await boot({});
    const body = await asJson(await fetch(`${h.base}/v1/instruments`));
    expect(body.isFallbackCatalog).toBe(false);
  });

  it('включённый источник без ключа не запускается и назван в /health отдельно', async () => {
    const reg = twoSourceRegistry();
    reg.providers = reg.providers.map((p) => (p.id === 'twelvedata' ? { ...p, requiresKey: true } : p));
    const h = await boot({ registry: reg, keys: new Map() });
    const health = await asJson(await fetch(`${h.base}/health`));
    expect(health.status).toBe('degraded');
    expect(health.reason).toContain('без ключа');
    expect(health.registry.missingKeys).toEqual(['twelvedata']);
    // И символ уезжает к запасному, а не остаётся без источника молча.
    expect(h.assigned('metals-alt')).toEqual(['XAUUSD']);
  });

  it('встроенное умолчание называет себя умолчанием в /health и в ручке', async () => {
    const h = await boot({ origin: 'builtin-default', registry: builtinRegistry() });
    expect((await asJson(await fetch(`${h.base}/health`))).registry.origin).toBe('builtin-default');
    expect((await asJson(await admin(h))).origin).toBe('builtin-default');
  });

  it('/v1/instruments показывает фактического ведущего, а не строку каталога', async () => {
    const h = await boot({});
    const items: { symbol: string; provider: string }[] = (
      await asJson(await fetch(`${h.base}/v1/instruments`))
    ).items;
    expect(items.find((i) => i.symbol === 'XAUUSD')?.provider).toBe('twelvedata');
    expect(items).toHaveLength(2);
  });
});

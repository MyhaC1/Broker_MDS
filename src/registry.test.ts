import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  builtinRegistry,
  diffRouting,
  registrySchema,
  resolveRouting,
  summarizeRouting,
  type Registry,
  type RoutingRuntime,
} from './registry.js';
import { loadRegistry, saveRegistry } from './registry-store.js';
import type { CatalogInstrument } from './types.js';

/**
 * Реестр провайдеров (Р-047), чистая часть: кто что ведёт и почему.
 *
 * Данные подобраны так, чтобы их было чем сломать: один символ с одним
 * источником, один символ с двумя источниками одной категории (настоящие
 * «два провайдера на один символ»), один символ-коллизия двух разных
 * категорий и один символ, который не ведёт никто. Вырожденный набор
 * «по одному источнику на всё» дал бы зелёный цвет при любой формуле выбора.
 */

function instrument(over: Partial<CatalogInstrument> & Pick<CatalogInstrument, 'symbol' | 'provider'>): CatalogInstrument {
  return {
    name: over.symbol,
    category: 'crypto',
    segment: null,
    digits: 2,
    providerSymbol: over.symbol.toLowerCase(),
    ...over,
  } as CatalogInstrument;
}

const CATALOG: CatalogInstrument[] = [
  // один источник
  instrument({ symbol: 'BTCUSD', provider: 'binance' }),
  // два источника одной категории — настоящий случай «или несколько»
  instrument({ symbol: 'XAUUSD', provider: 'twelvedata', category: 'metals' }),
  instrument({ symbol: 'XAUUSD', provider: 'metals-alt', category: 'metals' }),
  // коллизия канонического имени между РАЗНЫМИ категориями
  instrument({ symbol: 'EURUSD', provider: 'binance', category: 'crypto' }),
  instrument({ symbol: 'EURUSD', provider: 'twelvedata', category: 'forex' }),
  // категории нет ни у кого в covers
  instrument({ symbol: 'BRENT', provider: 'twelvedata', category: 'energy' }),
];

function registry(over: Partial<Registry> = {}): Registry {
  const base = builtinRegistry();
  return {
    ...base,
    providers: [
      { ...base.providers[0]! },
      { ...base.providers[1]!, enabled: true },
      {
        id: 'metals-alt',
        adapter: 'twelvedata',
        label: 'Запасной источник металлов',
        enabled: true,
        priority: 30,
        covers: ['metals'],
        maxSilenceMs: 120_000,
        requiresKey: true,
      },
    ],
    ...over,
  };
}

const quiet: RoutingRuntime = { silent: new Set(), sticky: new Map() };

describe('реестр · два провайдера на один символ', () => {
  it('ведёт один, остальные — запасные; выбор по приоритету и он назван', () => {
    const table = resolveRouting(CATALOG, registry(), quiet);
    const route = table.routes.get('XAUUSD')!;
    expect(route.leader?.providerId).toBe('twelvedata');
    expect(route.reason).toBe('primary');
    // Запасной не исчезает: он виден кандидатом, а не «берём первого молча».
    expect(route.candidates.map((c) => c.providerId)).toEqual(['twelvedata', 'metals-alt']);
  });

  it('символ попадает в задание РОВНО одному источнику, а не обоим', () => {
    const table = resolveRouting(CATALOG, registry(), quiet);
    expect(table.byProvider.get('twelvedata')?.map((i) => i.symbol)).toContain('XAUUSD');
    expect(table.byProvider.get('metals-alt')?.map((i) => i.symbol)).not.toContain('XAUUSD');
  });

  it('основной молчит → ведёт запасной, и причина названа failover', () => {
    const table = resolveRouting(CATALOG, registry(), {
      silent: new Set(['twelvedata']),
      sticky: new Map(),
    });
    const route = table.routes.get('XAUUSD')!;
    expect(route.leader?.providerId).toBe('metals-alt');
    expect(route.reason).toBe('failover');
    expect(table.failedOver.get('XAUUSD')).toBe('metals-alt');
  });

  it('автоматического возврата нет: основной ожил, но ведёт прежний запасной', () => {
    // Это РЕШЕНИЕ, а не недоделка (ADR-031): возврат дал бы второй разрыв
    // цены и дребезг на неустойчивом канале. Тест-растяжка — чтобы
    // «дозакрывающий полноту» увидел, что молчание здесь намеренное.
    const table = resolveRouting(CATALOG, registry(), {
      silent: new Set(),
      sticky: new Map([['XAUUSD', 'metals-alt']]),
    });
    expect(table.routes.get('XAUUSD')?.leader?.providerId).toBe('metals-alt');
    expect(table.routes.get('XAUUSD')?.reason).toBe('failover');
  });

  it('залипший источник выключили → возвращаемся к основному, а не остаёмся без цены', () => {
    const reg = registry();
    reg.providers = reg.providers.map((p) => (p.id === 'metals-alt' ? { ...p, enabled: false } : p));
    const table = resolveRouting(CATALOG, reg, {
      silent: new Set(),
      sticky: new Map([['XAUUSD', 'metals-alt']]),
    });
    expect(table.routes.get('XAUUSD')?.leader?.providerId).toBe('twelvedata');
  });

  it('все кандидаты молчат → ведущий остаётся назначенным, но причина silent', () => {
    const table = resolveRouting(CATALOG, registry(), {
      silent: new Set(['twelvedata', 'metals-alt']),
      sticky: new Map(),
    });
    const route = table.routes.get('XAUUSD')!;
    expect(route.reason).toBe('silent');
    // Не `no-source` и не `source-disabled`: источник есть и включён, он молчит.
    expect(route.leader).not.toBeNull();
  });
});

describe('реестр · отключённый источник и пустой реестр — разные состояния', () => {
  it('источник выключен → source-disabled, символ остаётся в таблице', () => {
    const reg = registry();
    reg.providers = reg.providers.map((p) => ({ ...p, enabled: p.id === 'binance' }));
    const table = resolveRouting(CATALOG, reg, quiet);
    const route = table.routes.get('XAUUSD')!;
    expect(route.reason).toBe('source-disabled');
    expect(route.leader).toBeNull();
    // Символ не исчез: «инструмента нет» и «источник выключен» — разное.
    expect(table.routes.has('XAUUSD')).toBe(true);
  });

  it('пустой реестр → каждый символ no-source, а не пустая таблица', () => {
    const table = resolveRouting(CATALOG, registry({ providers: [] }), quiet);
    expect(table.routes.size).toBe(4);
    expect([...table.routes.values()].every((r) => r.reason === 'no-source')).toBe(true);
    expect(summarizeRouting(table).routed).toBe(0);
  });

  it('категория не покрыта ни одним источником → no-source, а не тихое исчезновение', () => {
    const table = resolveRouting(CATALOG, registry(), quiet);
    expect(table.routes.get('BRENT')?.reason).toBe('no-source');
  });

  it('охват объявлен числом и у числа названа единица', () => {
    const summary = summarizeRouting(resolveRouting(CATALOG, registry(), quiet));
    expect(summary.checked).toBe(4);
    expect(summary.routed).toBe(3);
    expect(summary.unit).toContain('после разрешения коллизий');
  });
});

describe('реестр · коллизия канонического имени решается категорией, а не приоритетом', () => {
  it('EURUSD форекса важнее крипто-пары к USDT, хотя у binance приоритет выше', () => {
    const table = resolveRouting(CATALOG, registry(), quiet);
    const route = table.routes.get('EURUSD')!;
    expect(route.category).toBe('forex');
    expect(route.leader?.providerId).toBe('twelvedata');
    // Проигравшая запись названа, а не растворилась в console.info.
    expect(route.hiddenByCollision).toEqual([{ providerId: 'binance', category: 'crypto' }]);
  });

  it('правило лежит данными: смена precedence меняет исход', () => {
    const reg = registry({
      categoryPrecedence: ['crypto', 'forex', 'metals', 'indices', 'stocks', 'energy'],
    });
    const route = resolveRouting(CATALOG, reg, quiet).routes.get('EURUSD')!;
    expect(route.category).toBe('crypto');
    expect(route.leader?.providerId).toBe('binance');
  });
});

describe('реестр · что забывать при переключении', () => {
  it('смена и потеря источника дают invalidate, появление — нет', () => {
    const before = resolveRouting(CATALOG, registry(), quiet);
    const reg = registry();
    reg.providers = reg.providers.map((p) => ({ ...p, enabled: p.id === 'metals-alt' }));
    const after = resolveRouting(CATALOG, reg, quiet);

    const { invalidate, changed } = diffRouting(before, after);
    // XAUUSD сменил источник, BTCUSD и EURUSD его потеряли — всё это забываем.
    expect(invalidate.sort()).toEqual(['BTCUSD', 'EURUSD', 'XAUUSD']);
    expect(changed.find((c) => c.symbol === 'XAUUSD')).toEqual({
      symbol: 'XAUUSD',
      from: 'twelvedata',
      to: 'metals-alt',
    });
  });

  it('первая маршрутизация ничего не инвалидирует: цен ещё нет', () => {
    const table = resolveRouting(CATALOG, registry(), quiet);
    expect(diffRouting(null, table).invalidate).toEqual([]);
  });
});

describe('реестр · разбор строгий, потому что это производитель состояния', () => {
  it('незнакомое поле отвергается, а не отбрасывается молча', () => {
    const bad = { ...builtinRegistry(), somethingNew: true };
    expect(registrySchema.safeParse(bad).success).toBe(false);
  });

  it('несуществующий адаптер отвергается: включить нечего', () => {
    const reg = builtinRegistry();
    const bad = { ...reg, providers: [{ ...reg.providers[0]!, adapter: 'yahoo' }] };
    expect(registrySchema.safeParse(bad).success).toBe(false);
  });

  it('дубль id отвергается: маршрутизация по id станет неоднозначной', () => {
    const reg = builtinRegistry();
    const bad = { ...reg, providers: [reg.providers[0]!, { ...reg.providers[0]! }] };
    expect(registrySchema.safeParse(bad).success).toBe(false);
  });

  it('неполный categoryPrecedence отвергается: коллизии решать нечем', () => {
    const bad = { ...builtinRegistry(), categoryPrecedence: ['forex', 'crypto'] };
    const result = registrySchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('не покрывает'))).toBe(true);
    }
  });

  it('пустой список провайдеров — валидное состояние, а не ошибка', () => {
    // Пустой реестр законен и обязан быть отличим от сломанного.
    expect(registrySchema.safeParse({ ...builtinRegistry(), providers: [] }).success).toBe(true);
  });
});

describe('хранилище реестра · три исхода загрузки, и ни один не «пусто»', () => {
  function dir() {
    return mkdtempSync(join(tmpdir(), 'mds-registry-'));
  }

  it('файла нет → встроенное умолчание, и оно называет себя умолчанием', () => {
    const loaded = loadRegistry(join(dir(), 'нет.json'));
    expect(loaded.origin).toBe('builtin-default');
    expect(loaded.registry).not.toBeNull();
  });

  it('файла нет → он и НЕ создаётся: иначе «не настраивали» = «настроили так»', () => {
    const path = join(dir(), 'providers.json');
    loadRegistry(path);
    expect(loadRegistry(path).origin).toBe('builtin-default');
  });

  it('битый JSON → origin error и registry null, а НЕ умолчание', () => {
    const path = join(dir(), 'providers.json');
    writeFileSync(path, '{ это не json', 'utf8');
    const loaded = loadRegistry(path);
    expect(loaded.origin).toBe('error');
    expect(loaded.registry).toBeNull();
    expect(loaded.error).toContain('JSON');
  });

  it('валидный JSON, но не по схеме → error, а не частично принятый реестр', () => {
    const path = join(dir(), 'providers.json');
    writeFileSync(path, JSON.stringify({ version: 1, providers: [] }), 'utf8');
    const loaded = loadRegistry(path);
    expect(loaded.origin).toBe('error');
    expect(loaded.registry).toBeNull();
    expect(loaded.error).toContain('схема');
  });

  it('путь ведёт в каталог → error, а не умолчание', () => {
    const path = join(dir(), 'каталог-а-не-файл');
    mkdirSync(path);
    const loaded = loadRegistry(path);
    expect(loaded.origin).toBe('error');
    expect(loaded.registry).toBeNull();
  });

  it('сохранённое читается обратно и получает origin file', () => {
    const path = join(dir(), 'nested', 'providers.json');
    const reg = { ...builtinRegistry(), version: 7, updatedBy: 'cms' };
    saveRegistry(path, reg);
    const loaded = loadRegistry(path);
    expect(loaded.origin).toBe('file');
    expect(loaded.registry?.version).toBe(7);
    expect(loaded.registry?.updatedBy).toBe('cms');
  });
});

/** Тише воды: `chmodSync` на Windows прав не меняет, поэтому сценарий
 *  «файл есть, но читать нельзя» живым прогоном здесь не воспроизводится.
 *  Записано прямо в тесте, чтобы следующий не счёл пункт забытым и не
 *  дописал проверку, которая на этой машине зелёная по совпадению. */
describe.skip('хранилище реестра · нет прав на чтение (не воспроизводится на Windows)', () => {
  it('ENOACCES → error', () => {
    expect(chmodSync).toBeTypeOf('function');
  });
});

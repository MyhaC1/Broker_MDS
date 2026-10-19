/**
 * Мутационный прогон: вернуть дефект в код и посмотреть, что покраснело.
 *
 * Тест засчитывается, когда показано, что он краснеет. Отдельно важен
 * раскол по наборам: класс «написано и не вызывается» модульными тестами не
 * ловится в принципе, поэтому мутации на ПРОВОДКУ обязаны краснеть в
 * интеграционном наборе, и вывод «мутация не покрасила» без указания набора
 * недействителен.
 *
 * Запуск: node scripts/mutate.mjs [подстрока-имени-мутации]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const UNIT = ['src/registry.test.ts', 'src/api.test.ts', 'src/catalog.test.ts', 'src/hub.test.ts'];
const INTEGRATION = ['src/server.test.ts', 'src/providers/binance.test.ts', 'src/providers/twelvedata.test.ts'];

/** @type {{name: string, file: string, from: string, to: string, expect: string}[]} */
const MUTATIONS = [
  {
    name: 'проводка: переключение не забывает цену прежнего источника',
    file: 'src/server.ts',
    from: 'const invalidated = hub.invalidate(invalidate);\n    if (changed.length > 0)',
    to: 'const invalidated = 0;\n    if (changed.length > 0)',
    expect: 'интеграционный: цена выключенного источника доживает до порога',
  },
  {
    name: 'проводка: фильтр провенанса снят (запасной перебивает ведущего)',
    file: 'src/server.ts',
    from: "    const leader = table?.routes.get(quote.symbol)?.leader?.providerId;\n    if (leader !== providerId) {\n      shadowed += 1;\n      return;\n    }\n",
    to: '',
    expect: 'интеграционный: в снапшот проходит тик не от ведущего',
  },
  {
    name: 'проводка: источники не переназначаются при смене реестра',
    file: 'src/server.ts',
    from: 'provider.setInstruments(next.byProvider.get(id) ?? []);',
    to: 'void next;',
    expect: 'интеграционный: правка реестра остаётся на бумаге',
  },
  {
    name: 'выбор: молча берём первого включённого (игнор failover и sticky)',
    file: 'src/registry.ts',
    from: 'const chosen = stickyPick ?? live[0] ?? enabled[0]!;',
    to: 'const chosen = enabled[0]!;',
    expect: 'модульный + интеграционный: failover не происходит',
  },
  {
    name: 'состояния: нечитаемый реестр подменяется умолчанием',
    file: 'src/registry-store.ts',
    from: "    return { origin: 'error', registry: null, error: `JSON: ${(error as Error).message}`, path };",
    to: "    void error;\n    return { origin: 'builtin-default', registry: builtinRegistry(), path };",
    expect: 'модульный: отказ выглядит правдоподобным значением',
  },
  {
    name: 'доступ: ручка открыта, когда секрет не задан',
    file: 'src/admin.ts',
    from: "  if (configured === undefined || configured.trim() === '') {",
    to: '  if (false) {',
    expect: 'интеграционный: fail-open на служебной ручке',
  },
  {
    name: 'доступ: версия реестра не сверяется (потерянное обновление)',
    file: 'src/admin.ts',
    from: '  if (incoming.version !== current.version) {',
    to: '  if (false) {',
    expect: 'интеграционный: чужая правка затирается молча',
  },
  {
    name: 'коллизия: решается приоритетом провайдера, а не категорией',
    file: 'src/registry.ts',
    from: 'const bestRank = Math.min(...entries.map((e) => rankOf(e.category)));',
    to: 'const bestRank = rankOf(entries[0]!.category);',
    expect: 'модульный: крипто-пара к USDT перебивает форекс',
  },
  {
    name: 'ключи: источник без ключа запускается вхолостую',
    file: 'src/server.ts',
    from: "      .filter((p) => p.enabled && p.requiresKey && (deps.keys.get(p.id) ?? '') === '')",
    to: '      .filter(() => false)',
    expect: 'интеграционный: отказ настройки выглядит отказом сети',
  },
  {
    name: 'таймер тишины: half-open не детектируется',
    file: 'src/providers/binance.ts',
    from: '      this.startWatchdog(ws);',
    to: '      void ws;',
    expect: 'интеграционный (провайдеры): B-003 возвращается',
  },
  {
    name: 'дельта подписки: смена набора не доезжает до живого сокета',
    file: 'src/providers/binance.ts',
    from: '    if (ws && ws.readyState === WebSocket.OPEN) this.applyDelta(ws);',
    to: '    void ws;',
    expect: 'интеграционный (провайдеры): переназначение не доходит до источника',
  },
  {
    name: 'причины: «нет источника» подменяется «источник молчит»',
    file: 'src/api.ts',
    from: "    case 'no_source':\n      return 'no_source';",
    to: "    case 'no_source':\n      return 'source_silent';",
    expect: 'модульный: состояния снова неразличимы',
  },
];

function runSuite(files) {
  try {
    execSync(`npx vitest run ${files.join(' ')} --reporter=basic`, { stdio: 'pipe', encoding: 'utf8' });
    return 0;
  } catch (error) {
    const raw = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    // Цветовые коды терминала стоят между «Tests» и числом: без очистки
    // разбор молча не находит ничего и выдаёт «не покрасила».
    const out = raw.replace(/\[[0-9;]*m/g, '');
    const match = out.match(/Tests\s+(\d+) failed/);
    if (match) return Number(match[1]);
    // Падение не от проверок (например, ошибка типов в мутации) — это не
    // «покраснело», и выдавать его за красный нельзя.
    return -1;
  }
}

const filter = process.argv[2];
const picked = filter ? MUTATIONS.filter((m) => m.name.includes(filter)) : MUTATIONS;
const results = [];

for (const mutation of picked) {
  const original = readFileSync(mutation.file, 'utf8');
  // Файлы на этой машине с CRLF: якорь из нескольких строк иначе не
  // находится, и мутация молча «пропускается» — то есть проверка не
  // выполняется, а выглядит выполненной.
  const LF = String.fromCharCode(10);
  const CRLF = String.fromCharCode(13, 10);
  const eol = original.includes(CRLF) ? CRLF : LF;
  mutation.from = mutation.from.split(LF).join(eol);
  mutation.to = mutation.to.split(LF).join(eol);
  if (!original.includes(mutation.from)) {
    console.error(`ПРОПУЩЕНА (якорь не найден): ${mutation.name}`);
    results.push({ name: mutation.name, unit: 'якорь не найден', integration: '—' });
    continue;
  }
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to), 'utf8');
  try {
    const unit = runSuite(UNIT);
    const integration = runSuite(INTEGRATION);
    results.push({ name: mutation.name, unit, integration, expect: mutation.expect });
    console.log(`${unit === 0 && integration === 0 ? 'НЕ ПОКРАСИЛА' : 'ok'}  ${mutation.name}`);
    console.log(`        модульных: ${unit} · интеграционных: ${integration}`);
  } finally {
    writeFileSync(mutation.file, original, 'utf8');
  }
}

console.log('\n| мутация | модульных красных | интеграционных красных |');
console.log('| --- | --- | --- |');
for (const r of results) console.log(`| ${r.name} | ${r.unit} | ${r.integration} |`);
const dead = results.filter((r) => r.unit === 0 && r.integration === 0);
if (dead.length > 0) {
  console.log(`\nНЕ ПОКРАСИЛИ НИ ОДНОГО ТЕСТА (${dead.length}):`);
  for (const r of dead) console.log(` - ${r.name}`);
}

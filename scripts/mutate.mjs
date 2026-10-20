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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const UNIT = [
  'src/registry.test.ts',
  'src/api.test.ts',
  'src/catalog.test.ts',
  'src/hub.test.ts',
  'src/reason-codes.test.ts',
];
const INTEGRATION = [
  'src/server.test.ts',
  'src/providers/binance.test.ts',
  'src/providers/twelvedata.test.ts',
];

/**
 * Перечень, который ведут руками, отстаёт молча: новый файл проверок не
 * попал бы ни в один набор, мутации гонялись бы без него, и узнать об этом
 * было бы неоткуда — ровно так одиннадцать свежих проверок терминала не
 * запускались бы в CI. Поэтому состав наборов СВЕРЯЕТСЯ С ДИСКОМ, и
 * расхождение здесь — отказ с кодом возврата, а не строчка предупреждения.
 *
 * Общий прогон (`pnpm test`) эту проблему не имеет: он зовёт команду
 * проекта, а она берёт все `*.test.ts`. Раскол на два набора нужен только
 * здесь, потому что вывод «мутация не покрасила» без указания набора
 * недействителен.
 */
function assertSetsCoverDisk() {
  const onDisk = [];
  const SKIP = new Set(['node_modules', 'dist', '.git', '.github']);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) onDisk.push(full);
    }
  };
  // Обходим КОРЕНЬ, а не только `src`. Первая версия этого сторожа ходила
  // по `src` — и файл проверок, положенный рядом (в `tests/`, в корне),
  // был бы невидим и ему, и проверке типов: `tsconfig.test.json` тоже
  // привязан к `src/**/*.ts`. Прогон (`vitest run`) при этом подхватил бы
  // его откуда угодно. Сторож, слепой ровно там, где слеп охват, не
  // сторож.
  walk('.');
  const classified = new Set([...UNIT, ...INTEGRATION]);
  const unclassified = onDisk.filter((f) => !classified.has(f));
  const vanished = [...classified].filter((f) => !onDisk.includes(f));
  if (unclassified.length > 0 || vanished.length > 0) {
    console.error('ОТКАЗ: наборы мутационного прогона разошлись с диском.');
    for (const f of unclassified) console.error(`  не отнесён ни к одному набору: ${f}`);
    for (const f of vanished) console.error(`  числится в наборе, но файла нет: ${f}`);
    console.error('Пока это не исправлено, результат прогона неизвестен, а не зелёный.');
    process.exit(2);
  }
  console.log(`Наборы сверены с диском: файлов проверок ${onDisk.length}, все отнесены.`);
}

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
    from: "    case 'no-source':\n      return 'no-source';",
    to: "    case 'no-source':\n      return 'source-silent';",
    expect: 'модульный: состояния снова неразличимы',
  },
  {
    name: 'словарь: имя причины вернулось к подчёркиванию (Р-087)',
    file: 'src/api.ts',
    from: "  'not-in-catalog',",
    to: "  'not_in_catalog',",
    expect: 'модульный: стиль и состав оси символа расходятся с §4г',
  },
  {
    name: 'словарь: восьмая причина заведена в коде мимо §4г',
    file: 'src/api.ts',
    from: "  'registry-unreadable',\n] as const;",
    to: "  'registry-unreadable',\n  'source-unhappy',\n] as const;",
    expect: 'модульный: состав оси символа разошёлся с контрактом',
  },
  {
    name: 'умолчание: changePercent подставляется нулём (QA-05)',
    file: 'src/providers/twelvedata.ts',
    from: '  if (!Number.isFinite(changePercent)) return null;',
    to: '  const changePercentOr0 = Number.isFinite(changePercent) ? changePercent : 0;',
    expect: 'модульный: окрашиваемое поле снова врёт «рынок стоял»',
  },
  {
    name: 'умолчание: момент котировки подставляется нашим временем (QA-05)',
    file: 'src/providers/twelvedata.ts',
    from: '  if (typeof seconds !== \'number\' || !Number.isFinite(seconds) || seconds <= 0) return null;',
    to: '  if (typeof seconds !== \'number\' || !Number.isFinite(seconds) || seconds <= 0) {\n    return { symbol: instrument.symbol, name: instrument.name, category: instrument.category, price, digits: instrument.digits, changePercent, ts: Date.now(), source: sourceId };\n  }',
    expect: 'модульный: котировка с выдуманным моментом не протухает никогда',
  },
  {
    name: 'охват: /health снова объявляет ноль вместо «не считали» (QA-05)',
    file: 'src/server.ts',
    from: '      routed: summary === null ? null : summary.routed,\n      checked: summary === null ? null : summary.checked,',
    to: '      routed: summary?.routed ?? 0,\n      checked: summary?.checked ?? 0,',
    expect: 'интеграционный: две ручки расходятся в ответе про одну величину',
  },
];

/**
 * Прогон набора под мутацией.
 *
 * Возвращает не только число красных, но и ИМЕНА красных проверок: красный
 * без указания, какая опора покраснела, значит не больше зелёного. У зоны
 * `deploy` три мутации покраснели не по той причине — сторож переводов
 * строки срабатывал первым и обрывал прогон до самой проверки.
 *
 * Исходов ТРИ, а не два: зелено · покраснело · РЕЗУЛЬТАТ НЕИЗВЕСТЕН (прогон
 * упал не от проверок — ошибка типов в мутации, зависший процесс). Третий
 * исход не красный и не зелёный, и схлопывать его нельзя ни с тем, ни с
 * другим: «не сошлось» и «не смотрели» — разные вещи.
 */
function runSuite(files) {
  try {
    execSync(`npx vitest run ${files.join(' ')} --reporter=basic`, { stdio: 'pipe', encoding: 'utf8' });
    return { kind: 'green', failed: 0, names: [] };
  } catch (error) {
    const raw = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    // Цветовые коды терминала стоят между «Tests» и числом: без очистки
    // разбор молча не находит ничего и выдаёт «не покрасила».
    const out = raw.replace(/\u001b\[[0-9;]*m/g, '');
    const match = out.match(/Tests\s+(\d+) failed/);
    if (!match) {
      const why = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
      return { kind: 'unknown', failed: 0, names: [], why };
    }
    const names = [...out.matchAll(/^\s*(?:×|FAIL)\s+(.+?)\s*$/gm)].map((m) => m[1]).slice(0, 8);
    return { kind: 'red', failed: Number(match[1]), names };
  }
}

const show = (r) => (r.kind === 'unknown' ? 'РЕЗУЛЬТАТ НЕИЗВЕСТЕН' : String(r.failed));

assertSetsCoverDisk();

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
    // Харнесс, не нашедший якорь, ОБЯЗАН ПАДАТЬ. Дважды подряд печаталось
    // уверенное «0 красных», хотя подстановка не применилась: «ноль
    // красных» читается как результат («тесты слабые») и ведёт чинить то,
    // что не сломано. Продолжать прогон после непроставленной мутации
    // нельзя — остальные строки таблицы будут выглядеть такими же.
    console.error(`ОТКАЗ: якорь мутации не найден в ${mutation.file}: ${mutation.name}`);
    console.error('Результат всего прогона неизвестен, а не зелёный.');
    process.exit(2);
  }
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to), 'utf8');
  try {
    const unit = runSuite(UNIT);
    const integration = runSuite(INTEGRATION);
    const unknown = unit.kind === 'unknown' || integration.kind === 'unknown';
    const dead = !unknown && unit.failed === 0 && integration.failed === 0;
    results.push({ name: mutation.name, unit, integration, unknown, dead, expect: mutation.expect });
    console.log(`${unknown ? 'НЕИЗВЕСТНО  ' : dead ? 'НЕ ПОКРАСИЛА' : 'ok          '}  ${mutation.name}`);
    console.log(`        модульных: ${show(unit)} · интеграционных: ${show(integration)}`);
    // Какая именно опора покраснела: красное без этого ничем не отличается
    // от красного по соседней причине.
    for (const n of [...unit.names, ...integration.names]) console.log(`        красный: ${n}`);
    if (unit.why) console.log(`        модульный упал не от проверок: ${unit.why}`);
    if (integration.why) console.log(`        интеграционный упал не от проверок: ${integration.why}`);
  } finally {
    writeFileSync(mutation.file, original, 'utf8');
  }
}

console.log('\n| мутация | модульных красных | интеграционных красных |');
console.log('| --- | --- | --- |');
for (const r of results) console.log(`| ${r.name} | ${show(r.unit)} | ${show(r.integration)} |`);

// Невыполненные прогоны — первой строкой резюме и ДО чисел: резюме читают
// вместо отчёта.
const unknowns = results.filter((r) => r.unknown);
if (unknowns.length > 0) {
  console.log(`\nРЕЗУЛЬТАТ НЕИЗВЕСТЕН (${unknowns.length}) — прогон упал не от проверок:`);
  for (const r of unknowns) console.log(` - ${r.name}`);
}
const dead = results.filter((r) => r.dead);
if (dead.length > 0) {
  console.log(`\nНЕ ПОКРАСИЛИ НИ ОДНОГО ТЕСТА (${dead.length}):`);
  for (const r of dead) console.log(` - ${r.name}`);
}
console.log(
  `\nОхват: мутаций ${results.length} · покрасили ${results.length - dead.length - unknowns.length}` +
    ` · не покрасили ${dead.length} · результат неизвестен ${unknowns.length}`,
);
// У каждого исхода свой код возврата: «не сошлось» и «результат неизвестен»
// одним числом — ложь кодом возврата.
process.exit(dead.length > 0 ? 1 : unknowns.length > 0 ? 2 : 0);

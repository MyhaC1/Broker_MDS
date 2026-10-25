/**
 * Смоук живого MDS: health → реестр → REST-снапшот → socket.io (FeedDriver).
 *
 * **Смоук — потребитель нашего же контракта, и ломается он молча.** Дважды:
 * B-002 (переименовали поле `/health`) и B-005 (убрали `status` у провайдера
 * в MDS-03 — проверка «binance connected» судила по полю, которого больше
 * нет, и была красной месяц). Поэтому здесь судим по тем же величинам, что
 * и сервис: возраст данных и число свежих котировок, а не по состояниям
 * соединения, которых наружу сознательно не отдаётся.
 *
 * Адрес берётся из `MDS_URL`: у контура это :3103, локально :3003 —
 * зашитый адрес уже однажды проверял не тот экземпляр.
 *
 * ## Режимы (Р-092, MDS-07)
 *
 * `MDS_SMOKE_MODE` = `contract` | `live` | `all` (умолчание `all`, чтобы
 * ручной запуск не изменился).
 *
 * Смоук режется **по причине отказа**, а не помечается неблокирующим
 * целиком. Довод: дефект, проживший здесь месяц красным, — это проверка
 * формы нашего собственного ответа, от биржи не зависящая ничем. Пометив
 * смоук неблокирующим, мы вернули бы её в разряд некритичных, то есть
 * воспроизвели бы ровно тот отказ, который чиним.
 *
 * - `contract` — только то, что зависит от нас: форма ответов, коды причин,
 *   граница служебной ручки, протокол WS. Идёт против **поддельного
 *   апстрима** (`scripts/fake-binance.mjs`) и блокирует пуш.
 * - `live` — правдоподобие цены, живой тик, возраст тика. Зависит от чужой
 *   сети, поэтому живёт отдельным прогоном по расписанию.
 * - `all` — оба набора, как было до разделения.
 *
 * ## Три разных «не прошло», и схлопывать их нельзя
 *
 * - **расхождение** — проверка выполнена и не сошлась. Код возврата 1.
 * - **НЕ ВЫПОЛНЕНА** — проверка этому режиму принадлежит, но выполнить её
 *   было нечем (нет секрета). Результат неизвестен, и это не успех.
 *   Код возврата 3.
 * - **не в этом режиме** — проверка сознательно вынесена в соседний прогон.
 *   Дырой не является и на код возврата не влияет. Считать её
 *   «невыполненной» нельзя: тогда контрактный прогон краснел бы всегда, а
 *   красный, который всегда красный, перестают открывать.
 */
import { io } from 'socket.io-client';

const MDS = process.env.MDS_URL ?? 'http://localhost:3003';
const ADMIN_TOKEN = process.env.MDS_ADMIN_TOKEN ?? '';
const MODE = process.env.MDS_SMOKE_MODE ?? 'all';

if (!['contract', 'live', 'all'].includes(MODE)) {
  console.error(`MDS_SMOKE_MODE=${MODE} — знаю только contract, live, all`);
  process.exit(2);
}

/**
 * Метка поддельного апстрима. Те же значения заданы в
 * `scripts/fake-binance.mjs`; расхождение двух мест ловится самой проверкой
 * `fake`, а не вниманием читателя.
 */
const FAKE_MARKER = {
  symbol: 'FAKEUSD',
  price: 777.77,
  changePercent: 0.11,
  bid: 777.7,
  ask: 777.84,
};

/**
 * Метка пути «цена есть, стакана нет» (MDS-12). Символ, у которого лучших
 * цен нет никогда — так выглядит всё от второго поставщика. Цена не
 * сверяется: ряд движется, и важно, что цена **есть**, а лучшие цены
 * **присутствуют пустыми**.
 */
const FAKE_NOBOOK_MARKER = { symbol: 'NOBOOKUSD' };

/**
 * `contract` — не зависит от биржи, блокирует пуш;
 * `live`     — зависит от биржи, идёт по расписанию;
 * `fake`     — утверждает, что апстрим ПОДДЕЛЬНЫЙ. Только в режиме
 *              `contract`: без неё контрактный прогон однажды молча пойдёт
 *              против живой биржи, и мы решим, что проверили подделку.
 */
const RUNS = {
  contract: new Set(['contract', 'fake']),
  live: new Set(['live']),
  all: new Set(['contract', 'live']),
};
const active = RUNS[MODE];
const inScope = (tag) => active.has(tag);

let passed = 0;
let failed = 0;
const notExecuted = [];
const outOfScope = [];

const check = (tag, ok, label) => {
  if (!inScope(tag)) {
    outOfScope.push(label);
    return;
  }
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`);
  if (ok) passed++;
  else failed++;
};

/** Проверка принадлежит режиму, но выполнить её было нечем. Не успех. */
const unexecuted = (tag, label, why) => {
  if (!inScope(tag)) {
    outOfScope.push(label);
    return;
  }
  console.log(`SKIP  ${label} — ${why}: проверка НЕ ВЫПОЛНЕНА, результат неизвестен`);
  notExecuted.push(`${label} (${why})`);
};

// подождать пока провайдер подключится и придут первые тики
let health;
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`${MDS}/health`);
    health = await res.json();
    if (health.providers?.some((p) => p.lastTickAt > 0)) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}

const binance = health?.providers?.find((p) => p.name === 'binance');

// Форма ответа. От биржи не зависит ничем — именно здесь месяц жил красный
// дефект (убрали поле, смоук продолжал его сверять), и именно поэтому это
// блокирующая половина, а не неблокирующая.
check(
  'contract',
  Array.isArray(health?.providers) &&
    typeof binance?.quoted === 'number' &&
    binance?.lastTickAgeMs !== undefined &&
    binance?.fresh !== undefined &&
    typeof health?.uptimeSec === 'number',
  `health: форма на месте (providers[], quoted/fresh/lastTickAgeMs у провайдера, uptimeSec=${health?.uptimeSec})`,
);

// Живость меряем тем же, чем её меряет сервис: свежими котировками.
// Состояния сокета в ответе нет и не будет — поле, способное соврать, хуже
// отсутствующего (B-003).
check(
  'live',
  (binance?.fresh ?? 0) > 0,
  `health: status=${health?.status}, binance свежих ${binance?.fresh}/${binance?.quoted}, ` +
    `возраст последнего тика ${binance?.lastTickAgeMs} мс`,
);

// Реестр провайдеров (Р-047): origin обязан называть себя, иначе умолчание
// неотличимо от выбранного оператором.
const reg = health?.registry;
check(
  'contract',
  ['file', 'builtin-default'].includes(reg?.origin) && reg?.routed > 0,
  `реестр: origin=${reg?.origin} v${reg?.version}, маршрутизировано ${reg?.routed} из ${reg?.checked} символов` +
    (reg?.origin === 'builtin-default' ? ' — ВСТРОЕННОЕ УМОЛЧАНИЕ, его никто не выбирал' : '') +
    (reg?.missingKeys?.length ? ` · без ключа: ${reg.missingKeys.join(',')}` : ''),
);

const inst = await (await fetch(`${MDS}/v1/instruments`)).json();
const provs = [...new Set(inst.items?.map((i) => i.provider) ?? [])];
check(
  'contract',
  inst.items?.length >= 3 &&
    typeof inst.catalogSource === 'string' &&
    typeof inst.isFallbackCatalog === 'boolean',
  `instruments: ${inst.items?.length} ведомых инструментов, источники=${provs.join('+')}, ` +
    `каталог=${inst.catalogSource}${inst.isFallbackCatalog ? ' (ЗАПАСНОЙ — число не равно живой вселенной)' : ''}`,
);

const snap = await (await fetch(`${MDS}/v1/quotes?symbols=BTCUSD,ETHUSD`)).json();
const btc = snap.items?.find((q) => q.symbol === 'BTCUSD');
check(
  'live',
  Boolean(btc && btc.price > 1000 && Number.isFinite(btc.changePercent) && btc.source),
  `REST снапшот: BTCUSD=${btc?.price} (${btc?.changePercent}%), источник=${btc?.source}`,
);

// Апстрим обязан быть опознан как ПОДДЕЛЬНЫЙ, и опознан ДАННЫМИ, а не
// полем, которым мок себя называет: у боевого Binance актива FAKE нет.
// Красная здесь означает, что прогон разговаривает не с подделкой, и тогда
// всё остальное в нём не значит ничего.
const fakeBody = await (await fetch(`${MDS}/v1/quotes?symbols=${FAKE_MARKER.symbol}`)).json();
const fakeQuote = fakeBody.items?.[0];
check(
  'fake',
  fakeQuote?.price === FAKE_MARKER.price && fakeQuote?.changePercent === FAKE_MARKER.changePercent,
  `апстрим ПОДДЕЛЬНЫЙ и опознан: ${FAKE_MARKER.symbol}=${fakeQuote?.price} ` +
    `(${fakeQuote?.changePercent}%) — у боевого Binance такого актива нет`,
);

// Лучшие цены доезжают от кадра апстрима до тела ручки (MDS-12). Проверка
// сквозная нарочно: разбор, показанный у провайдера, ничего не говорит о
// том, что поле уцелело в хабе и в сериализации. Режим `contract`: значения
// заданы подделкой, от биржи не зависят, и расхождение обязано блокировать
// пуш.
check(
  'contract',
  fakeQuote?.bid === FAKE_MARKER.bid && fakeQuote?.ask === FAKE_MARKER.ask,
  `лучшие цены доехали из кадра в ответ: bid=${fakeQuote?.bid} ask=${fakeQuote?.ask}`,
);

/*
  Вторая половина: цена без стакана — законный исход, а не отказ.

  Проверяется на символе, у которого стакана нет НИКОГДА — так выглядит всё,
  что приходит от второго поставщика. Ловить редкую точку в движущемся ряду
  опросом здесь уже пробовали: ряд шагает каждые 200 мс, опрос шёл каждые
  400 мс, выборка стабильно попадала на чётные шаги, и проверка не
  срабатывала НИ РАЗУ, выглядя при этом «иногда невезучей».

  Поля обязаны ПРИСУТСТВОВАТЬ, а не исчезать: пропавшее поле потребитель
  прочитает как «сосед ещё не шлёт», пустое — как «шлёт, и у него этого
  нет». Это разные сообщения, и путать их нельзя.
*/
const nbBody = await (await fetch(`${MDS}/v1/quotes?symbols=${FAKE_NOBOOK_MARKER.symbol}`)).json();
const nb = nbBody.items?.[0];
check(
  'contract',
  Boolean(nb) && nb.price > 0 && 'bid' in nb && 'ask' in nb && nb.bid === null && nb.ask === null,
  `цена без стакана — законный исход: ${FAKE_NOBOOK_MARKER.symbol}=${nb?.price}, ` +
    `bid=${JSON.stringify(nb?.bid)} ask=${JSON.stringify(nb?.ask)} (поля на месте, значения пусты)`,
);

// Недоступный символ обязан называть причину, а не молча отсутствовать.
// Имена причин — kebab-case (Р-087, КОНТРАКТЫ.md §4г).
const unknown = await (await fetch(`${MDS}/v1/quotes?symbols=NOSUCHSYM`)).json();
check(
  'contract',
  unknown.unavailable?.[0]?.reason === 'not-in-catalog',
  `причина недоступности названа: ${JSON.stringify(unknown.unavailable?.[0])}`,
);

// Служебная ручка: без секрета не пускает. Проверка границы, а не удобства.
const noToken = await fetch(`${MDS}/v1/admin/providers`);
check(
  'contract',
  noToken.status === 401 || noToken.status === 503,
  `служебная ручка без секрета: HTTP ${noToken.status} (401 не пустили / 503 выключена)`,
);
check(
  'contract',
  noToken.headers.get('access-control-allow-origin') === null,
  'служебная ручка не отдаёт CORS-заголовок — из браузера не дотянуться',
);

if (ADMIN_TOKEN) {
  const withToken = await fetch(`${MDS}/v1/admin/providers`, {
    headers: { 'X-MDS-Admin-Token': ADMIN_TOKEN },
  });
  const body = withToken.ok ? await withToken.json() : null;
  check(
    'contract',
    withToken.status === 200 && Array.isArray(body?.registry?.providers),
    `служебная ручка с секретом: HTTP ${withToken.status}, источников ${body?.registry?.providers?.length}`,
  );
  check(
    'contract',
    !JSON.stringify(body ?? {}).includes(ADMIN_TOKEN),
    'ручка не отражает секрет в ответе',
  );
} else {
  // Непроверенное обязано быть отличимо от пройденного.
  unexecuted('contract', 'служебная ручка с секретом', 'MDS_ADMIN_TOKEN не задан');
  unexecuted('contract', 'ручка не отражает секрет в ответе', 'MDS_ADMIN_TOKEN не задан');
}

// socket.io: контракт драйвера сайта
const socket = io(MDS, { transports: ['websocket'] });
const gotSnapshot = new Promise((resolve) => socket.once('quotes:batch', resolve));
await new Promise((resolve) => socket.on('connect', resolve));
socket.emit('subscribe', ['BTCUSD', 'ETHUSD']);
const snapshot = await Promise.race([gotSnapshot, new Promise((r) => setTimeout(() => r(null), 5000))]);
check(
  'contract',
  Array.isArray(snapshot) && snapshot.some((q) => q.symbol === 'BTCUSD'),
  `WS: снапшот на subscribe (${snapshot?.length} котировок)`,
);

// живой батч после снапшота (реальный тик Binance долетает за секунды)
if (inScope('live')) {
  const liveBatch = await Promise.race([
    new Promise((resolve) => socket.once('quotes:batch', resolve)),
    new Promise((r) => setTimeout(() => r(null), 20000)),
  ]);
  check(
    'live',
    Array.isArray(liveBatch) && liveBatch.every((q) => ['BTCUSD', 'ETHUSD'].includes(q.symbol)),
    `WS: живой батч (${liveBatch?.map((q) => `${q.symbol}=${q.price}`).join(', ')})`,
  );
} else {
  outOfScope.push('WS: живой батч');
}

// unsubscribe: батчи по отписанным не приходят
socket.emit('unsubscribe', ['BTCUSD', 'ETHUSD']);
await new Promise((r) => setTimeout(r, 300));
const afterUnsub = await Promise.race([
  new Promise((resolve) => socket.once('quotes:batch', resolve)),
  new Promise((r) => setTimeout(() => r('silence'), 3000)),
]);
check('contract', afterUnsub === 'silence', 'WS: после unsubscribe — тишина');

socket.close();

/* ------------------------------------------------------------------ */
/* Резюме. Невыполненные проверки — ПЕРВОЙ СТРОКОЙ и ДО чисел:        */
/* резюме читают вместо отчёта.                                        */
/* ------------------------------------------------------------------ */

console.log(`\n--- смоук, режим ${MODE} ---`);
if (notExecuted.length > 0) {
  console.log(`НЕ ВЫПОЛНЕНО ${notExecuted.length} — результат по ним НЕИЗВЕСТЕН:`);
  for (const label of notExecuted) console.log(` - ${label}`);
}
if (failed > 0) console.log(`РАСХОЖДЕНИЙ ${failed}`);
console.log(
  `Охват: проверок этого режима ${passed + failed + notExecuted.length} ` +
    `(прошло ${passed} · расхождений ${failed} · не выполнено ${notExecuted.length}); ` +
    `вынесено в соседний прогон ${outOfScope.length}`,
);
if (outOfScope.length > 0) {
  for (const label of outOfScope) console.log(` · не в этом режиме: ${label}`);
}

// Исходов три, и у каждого свой код возврата: «не сошлось» и «не смотрели»
// одним числом — это ложь кодом возврата.
if (failed > 0) process.exit(1);
if (notExecuted.length > 0) process.exit(3);
console.log('ALL OK');
process.exit(0);

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
 */
import { io } from 'socket.io-client';

const MDS = process.env.MDS_URL ?? 'http://localhost:3003';
const ADMIN_TOKEN = process.env.MDS_ADMIN_TOKEN ?? '';
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
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

// Живость меряем тем же, чем её меряет сервис: свежими котировками.
// Состояния сокета в ответе нет и не будет — поле, способное соврать, хуже
// отсутствующего (B-003).
const binance = health?.providers?.find((p) => p.name === 'binance');
check(
  (binance?.fresh ?? 0) > 0,
  `health: status=${health?.status}, binance свежих ${binance?.fresh}/${binance?.quoted}, ` +
    `возраст последнего тика ${binance?.lastTickAgeMs} мс`,
);

// Реестр провайдеров (Р-047): origin обязан называть себя, иначе умолчание
// неотличимо от выбранного оператором.
const reg = health?.registry;
check(
  ['file', 'builtin-default'].includes(reg?.origin) && reg?.routed > 0,
  `реестр: origin=${reg?.origin} v${reg?.version}, маршрутизировано ${reg?.routed} из ${reg?.checked} символов` +
    (reg?.origin === 'builtin-default' ? ' — ВСТРОЕННОЕ УМОЛЧАНИЕ, его никто не выбирал' : '') +
    (reg?.missingKeys?.length ? ` · без ключа: ${reg.missingKeys.join(',')}` : ''),
);

const inst = await (await fetch(`${MDS}/v1/instruments`)).json();
const provs = [...new Set(inst.items?.map((i) => i.provider) ?? [])];
check(
  inst.items?.length >= 5 && inst.catalogSource !== undefined,
  `instruments: ${inst.items?.length} ведомых инструментов, источники=${provs.join('+')}, ` +
    `каталог=${inst.catalogSource}${inst.isFallbackCatalog ? ' (ЗАПАСНОЙ — число не равно живой вселенной)' : ''}`,
);

const snap = await (await fetch(`${MDS}/v1/quotes?symbols=BTCUSD,ETHUSD`)).json();
const btc = snap.items?.find((q) => q.symbol === 'BTCUSD');
check(
  Boolean(btc && btc.price > 1000 && Number.isFinite(btc.changePercent) && btc.source),
  `REST снапшот: BTCUSD=${btc?.price} (${btc?.changePercent}%), источник=${btc?.source}`,
);

// Недоступный символ обязан называть причину, а не молча отсутствовать.
const unknown = await (await fetch(`${MDS}/v1/quotes?symbols=NOSUCHSYM`)).json();
check(
  unknown.unavailable?.[0]?.reason === 'not_in_catalog',
  `причина недоступности названа: ${JSON.stringify(unknown.unavailable?.[0])}`,
);

// Служебная ручка: без секрета не пускает. Проверка границы, а не удобства.
const noToken = await fetch(`${MDS}/v1/admin/providers`);
check(
  noToken.status === 401 || noToken.status === 503,
  `служебная ручка без секрета: HTTP ${noToken.status} (401 не пустили / 503 выключена)`,
);
check(
  noToken.headers.get('access-control-allow-origin') === null,
  'служебная ручка не отдаёт CORS-заголовок — из браузера не дотянуться',
);

if (ADMIN_TOKEN) {
  const withToken = await fetch(`${MDS}/v1/admin/providers`, {
    headers: { 'X-MDS-Admin-Token': ADMIN_TOKEN },
  });
  const body = withToken.ok ? await withToken.json() : null;
  check(
    withToken.status === 200 && Array.isArray(body?.registry?.providers),
    `служебная ручка с секретом: HTTP ${withToken.status}, источников ${body?.registry?.providers?.length}`,
  );
  check(
    !JSON.stringify(body ?? {}).includes(ADMIN_TOKEN),
    'ручка не отражает секрет в ответе',
  );
} else {
  // Непроверенное обязано быть отличимо от пройденного.
  console.log('SKIP  ручка с секретом: MDS_ADMIN_TOKEN не задан — проверка НЕ ВЫПОЛНЕНА');
}

// socket.io: контракт драйвера сайта
const socket = io(MDS, { transports: ['websocket'] });
const gotSnapshot = new Promise((resolve) => socket.once('quotes:batch', resolve));
await new Promise((resolve) => socket.on('connect', resolve));
socket.emit('subscribe', ['BTCUSD', 'ETHUSD']);
const snapshot = await Promise.race([gotSnapshot, new Promise((r) => setTimeout(() => r(null), 5000))]);
check(
  Array.isArray(snapshot) && snapshot.some((q) => q.symbol === 'BTCUSD'),
  `WS: снапшот на subscribe (${snapshot?.length} котировок)`,
);

// живой батч после снапшота (реальный тик Binance долетает за секунды)
const liveBatch = await Promise.race([
  new Promise((resolve) => socket.once('quotes:batch', resolve)),
  new Promise((r) => setTimeout(() => r(null), 20000)),
]);
check(
  Array.isArray(liveBatch) && liveBatch.every((q) => ['BTCUSD', 'ETHUSD'].includes(q.symbol)),
  `WS: живой батч (${liveBatch?.map((q) => `${q.symbol}=${q.price}`).join(', ')})`,
);

// unsubscribe: батчи по отписанным не приходят
socket.emit('unsubscribe', ['BTCUSD', 'ETHUSD']);
await new Promise((r) => setTimeout(r, 300));
const afterUnsub = await Promise.race([
  new Promise((resolve) => socket.once('quotes:batch', resolve)),
  new Promise((r) => setTimeout(() => r('silence'), 3000)),
]);
check(afterUnsub === 'silence', 'WS: после unsubscribe — тишина');

socket.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL OK');
process.exit(failures ? 1 : 0);

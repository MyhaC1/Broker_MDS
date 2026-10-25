import 'dotenv/config';

import { CATALOG, fetchBinanceSpotUniverse } from './catalog.js';
import { config } from './config.js';
import { loadRegistry } from './registry-store.js';
import { createMdsServer } from './server.js';
import type { ProviderEntry } from './registry.js';

/**
 * MDS — Market Data Service (ADR-024 платформы).
 * Stateless по котировкам: последние цены в памяти, восстанавливаются от
 * источников за секунды после рестарта. Ключи источников живут ТОЛЬКО здесь.
 *
 * С Р-047 набор источников — **не свойство сборки, а настраиваемое
 * состояние**: реестр провайдеров лежит файлом, читается при старте и
 * меняется служебной ручкой `/v1/admin/providers`, которую зовёт админка CMS
 * сервер-сервером. Направление связи только такое: MDS от CMS не зависит и
 * зависеть не должен — иначе контентная система станет точкой отказа
 * торговой.
 *
 * Этот файл — только запуск: вся проводка в `server.ts`, чтобы её можно было
 * поднять в тесте целиком.
 *
 * REST:
 *   GET  /health                 — состояние сервиса, источников и реестра
 *   GET  /v1/instruments         — вселенная (+ catalogSource, покрытие)
 *   GET  /v1/quotes?symbols=A,B  — снапшот + причины недоступности по каждому
 *   GET  /icons/<SYMBOL>.svg     — иконка инструмента
 *   GET  /v1/admin/providers     — реестр (секрет, сервер-сервер)
 *   PUT  /v1/admin/providers     — смена реестра (секрет, сервер-сервер)
 *   GET  /v1/admin/audit         — журнал изменений реестра в памяти
 * WS (socket.io) — контракт FeedDriver сайта: subscribe/unsubscribe → quotes:batch
 */

let cryptoUniverse = await fetchBinanceSpotUniverse(config.binanceApiUrl);
let catalogSource = 'binance-exchange-info';
if (!cryptoUniverse) {
  cryptoUniverse = CATALOG.filter((i) => i.provider === 'binance');
  catalogSource = 'static-fallback';
  console.warn(
    `[mds] exchangeInfo недоступен — крипта из ЗАПАСНОГО каталога (${cryptoUniverse.length} инструментов). ` +
      'Это число не является размером живой вселенной.',
  );
} else {
  console.info(`[mds] Binance: ${cryptoUniverse.length} спот-пар к USDT`);
}

// Каталог — это то, что адаптеры УМЕЮТ стримить. Кто из них что ведёт
// фактически, решает реестр: записи Twelve Data остаются в каталоге, даже
// если источник выключен, иначе выключение выглядело бы как исчезновение
// инструментов из вселенной.
const catalog = [...cryptoUniverse, ...CATALOG.filter((i) => i.provider === 'twelvedata')];

const loaded = loadRegistry(config.registryPath);
if (loaded.origin === 'builtin-default') {
  console.warn(
    `[mds] реестра провайдеров нет (${loaded.path}) — работаем по ВСТРОЕННОМУ УМОЛЧАНИЮ. ` +
      'Его никто не выбирал; файл на старте сознательно не создаётся, чтобы ' +
      '«никто не настраивал» не стало неотличимо от «настроили ровно так».',
  );
}

/**
 * Ключ источника. Сначала общий вид `MDS_PROVIDER_KEY_<ID>`, затем
 * исторические переменные, чтобы существующие развёртки не сломались.
 *
 * **Чего этот общий вид НЕ даёт (MDS-13, поправка 25.10).** Здесь было
 * написано, что он «делает добавление второго источника того же адаптера
 * правкой данных плюс одной переменной, а не правкой кода». Это неправда, и
 * обошлась она дорого: разбор зоны принял обещание за свойство и насчитал
 * 513 символов риска там, где их нет.
 *
 * Правда такая: реестр ко второму источнику готов, **каталог — нет**.
 * `provider` в строке каталога стоит литералом (`'binance'` в
 * `fetchBinanceSpotUniverse`, `'binance'` и `'twelvedata'` в `CATALOG`), и
 * запись реестра с новым `id` не упоминается в каталоге никем. Источник
 * запустится и получит пустой список инструментов. Проверено опытом 25.10:
 * добавление `binance-2` ТОЛЬКО в реестр даёт 0 символов с двумя
 * кандидатами; 513 получаются лишь после правки каталога, то есть кода.
 *
 * Обещание исправлено, а не код: ссылка каталога на источник по данным —
 * работа, для которой сегодня нет повода. Когда повод появится, снимется и
 * эта оговорка, и запрет из Р-318 станет целиться в существующий путь.
 */
function keyFor(entry: ProviderEntry): string {
  const generic = process.env[`MDS_PROVIDER_KEY_${entry.id.toUpperCase().replace(/-/g, '_')}`];
  if (generic) return generic;
  if (entry.adapter === 'twelvedata') return config.twelveData.apiKey;
  return '';
}

const keys = new Map((loaded.registry?.providers ?? []).map((p) => [p.id, keyFor(p)]));

const server = createMdsServer({
  catalog,
  catalogSource,
  loaded,
  staleAfterMs: config.staleAfterMs,
  adminToken: config.adminToken,
  allowRoutingIdentityChange: config.allowRoutingIdentityChange,
  keys,
});

if (config.staleAfterMs === null) {
  console.error(
    '[mds] QUOTE_STALE_AFTER_MS не задан. Порог свежести не имеет умолчания ' +
      '(КОНТРАКТЫ.md §5г): без него MDS не может отличить текущую цену от ' +
      'вчерашней и НЕ ОТДАЁТ КОТИРОВОК ВОВСЕ — /v1/quotes пуст, /health 503.',
  );
} else {
  console.info(`[mds] порог свежести котировки: ${config.staleAfterMs} мс`);
}

if (config.adminToken === undefined || config.adminToken === '') {
  console.warn(
    '[mds] MDS_ADMIN_TOKEN не задан — служебная ручка управления провайдерами ' +
      'ВЫКЛЮЧЕНА (503). Реестр читается из файла и меняется только правкой файла.',
  );
}

server.httpServer.listen(config.port, () => {
  const table = server.routing();
  const routed = table ? [...table.routes.values()].filter((r) => r.leader).length : 0;
  console.info(
    `[mds] listening on :${config.port} — каталог ${catalog.length} (${catalogSource}), ` +
      `маршрутизировано ${routed}, реестр ${loaded.origin} v${loaded.registry?.version ?? '—'}`,
  );
});

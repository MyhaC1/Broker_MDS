import 'dotenv/config';

import { createServer } from 'node:http';

import { CATALOG, groupLabelFor } from './catalog.js';
import { config } from './config.js';
import { QuoteHub } from './hub.js';
import { iconPathFor, iconSvg } from './icons.js';
import { BinanceProvider } from './providers/binance.js';
import { TwelveDataProvider } from './providers/twelvedata.js';

/**
 * MDS — Market Data Service (ADR-024 платформы).
 * Stateless: последние котировки в памяти, восстанавливаются от провайдеров
 * за секунды после рестарта. Ключи провайдеров живут ТОЛЬКО здесь:
 * Binance (крипта, public без ключа) + Twelve Data (форекс/металлы/акции/
 * индексы, ключ в env) — параллельно, каждый стримит свою часть вселенной.
 * Каталог (вселенная стримящихся инструментов) — статический src/catalog.ts;
 * CMS выбирает из него инструменты сайтов, зависимости от CMS нет.
 *
 * REST:
 *   GET /health                 — статус сервиса и провайдеров
 *   GET /v1/instruments         — вселенная (что реально стримим, + icon/group)
 *   GET /v1/quotes?symbols=A,B  — снапшот котировок
 *   GET /icons/<SYMBOL>.svg     — иконка инструмента
 * WS (socket.io) — контракт FeedDriver сайта: subscribe/unsubscribe → quotes:batch
 */

// Без ключа Twelve Data его инструменты выпадают из вселенной:
// в /v1/instruments только то, что РЕАЛЬНО стримится
const universe = config.twelveData.apiKey
  ? CATALOG
  : CATALOG.filter((i) => i.provider !== 'twelvedata');
if (!config.twelveData.apiKey) {
  console.warn('[mds] TWELVEDATA_API_KEY не задан — вселенная только Binance (крипта)');
}

const startedAt = Date.now();
const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://mds');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/health') {
    const providers = [
      { name: 'binance', status: binance.status, lastTickAt: binance.lastTickAt },
      ...(twelve
        ? [{ name: 'twelvedata', status: twelve.status, lastTickAt: twelve.lastTickAt }]
        : []),
    ];
    const allConnected = providers.every((p) => p.status === 'connected');
    const body = {
      status: allConnected ? 'ok' : 'degraded',
      providers,
      catalog: { source: 'static', instruments: universe.length },
      clients: hub.clientCount,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
    };
    // 200 пока жив хотя бы основной realtime-провайдер (Binance):
    // Twelve Data — поллер, между опросами это не деградация сервиса
    res.writeHead(binance.status === 'connected' ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(body));
    return;
  }

  if (url.pathname === '/v1/instruments') {
    // Символы, отвергнутые тарифом провайдера, — не «реально стримятся»
    const rejected = new Set(twelve?.rejectedSymbols ?? []);
    const items = universe
      .filter((i) => !rejected.has(i.symbol))
      .map((i) => ({
        ...i,
        icon: iconPathFor(i.symbol),
        group: groupLabelFor(i),
      }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ items }));
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
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
    return;
  }

  if (url.pathname === '/v1/quotes') {
    const symbols = url.searchParams.get('symbols')?.split(',').filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ items: hub.snapshot(symbols) }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const hub = new QuoteHub(httpServer);

const binance = new BinanceProvider((quote) => hub.push(quote));
binance.setInstruments(universe.filter((i) => i.provider === 'binance'));

const twelve = config.twelveData.apiKey
  ? new TwelveDataProvider((quote) => hub.push(quote), config.twelveData)
  : null;
if (twelve) {
  twelve.setInstruments(universe.filter((i) => i.provider === 'twelvedata'));
  twelve.connect();
}

httpServer.listen(config.port, () => {
  console.info(
    `[mds] listening on :${config.port} (${universe.length} instruments, providers: binance${twelve ? '+twelvedata' : ''})`,
  );
});

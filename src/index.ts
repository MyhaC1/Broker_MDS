import 'dotenv/config';

import { createServer } from 'node:http';
import { CATALOG } from './catalog.js';
import { config } from './config.js';
import { QuoteHub } from './hub.js';
import { BinanceProvider } from './providers/binance.js';

/**
 * MDS — Market Data Service (ADR-024 платформы).
 * Stateless: последние котировки в памяти, восстанавливаются от провайдера
 * за секунды после рестарта. Ключи провайдеров живут ТОЛЬКО здесь
 * (Binance public — без ключа; платные придут с проверкой лицензий, R-T5).
 * Каталог (вселенная стримящихся инструментов) — статический src/catalog.ts;
 * CMS выбирает из него инструменты сайтов, зависимости от CMS нет.
 *
 * REST:
 *   GET /health                 — статус сервиса/провайдера
 *   GET /v1/instruments         — вселенная (что реально стримим)
 *   GET /v1/quotes?symbols=A,B  — снапшот котировок
 * WS (socket.io) — контракт FeedDriver сайта: subscribe/unsubscribe → quotes:batch
 */

const startedAt = Date.now();
const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://mds');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/health') {
    const body = {
      status: provider.status === 'connected' ? 'ok' : 'degraded',
      provider: { name: 'binance', status: provider.status, lastTickAt: provider.lastTickAt },
      catalog: { source: 'static', instruments: CATALOG.length },
      clients: hub.clientCount,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
    };
    res.writeHead(provider.status === 'connected' ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  if (url.pathname === '/v1/instruments') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: CATALOG }));
    return;
  }

  if (url.pathname === '/v1/quotes') {
    const symbols = url.searchParams.get('symbols')?.split(',').filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: hub.snapshot(symbols) }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const hub = new QuoteHub(httpServer);
const provider = new BinanceProvider((quote) => hub.push(quote));
provider.setInstruments(CATALOG);

httpServer.listen(config.port, () => {
  console.info(`[mds] listening on :${config.port} (${CATALOG.length} instruments)`);
});

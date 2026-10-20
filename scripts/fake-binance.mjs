/**
 * Поддельный апстрим Binance для контрактной половины смоука.
 *
 * Зачем он есть. Контрактные проверки — это проверки **формы нашего
 * собственного ответа**, и они не должны зависеть от чужой сети ничем.
 * Именно в этой половине месяц жил красный дефект (MDS-03 убрала поле
 * `status` у провайдера, смоук продолжал его сверять), и именно поэтому она
 * блокирует пуш, а не помечается неблокирующей.
 *
 * ОН ОБЯЗАН БЫТЬ ОТЛИЧИМ ОТ БОЕВОГО, и это не пожелание. Мок, неотличимый
 * от настоящего драйвера, — не заглушка, а подделка данных: однажды
 * контрактный прогон молча пойдёт против живой биржи, и мы решим, что
 * проверили подделку.
 *
 * Отличие сделано **данными, а не полем, которым мок себя называет**: в
 * выдаваемой вселенной есть инструмент-метка `FAKEUSDT` (канонически
 * `FAKEUSD`) с постоянной ценой. У Binance актива `FAKE` нет; если смоук в
 * режиме `contract` этого инструмента не видит — он разговаривает не с нами,
 * и это отказ, а не мелочь.
 *
 * ПОЧЕМУ ОН ОТДАЁТ ЕЩЁ И `exchangeInfo`, хотя в предложении `deploy` этого
 * не было. MDS берёт вселенную по HTTP из `BINANCE_API_URL`, и это
 * ОТДЕЛЬНАЯ переменная от `BINANCE_WS_URL`. Подменив только WS, контрактный
 * прогон всё равно ходил бы в `api.binance.com` — то есть «половина без
 * чужой сети» зависела бы от чужой сети. Подробнее — в отчёте: предложенная
 * проверка «каталог запасной» проходила бы ровно тогда, когда сеть сломана,
 * и краснела бы, когда она работает.
 *
 * ЧЕМ СЛОМАТЬ СЕРИЮ. Вырожденная серия даёт зелёный цвет вместо проверки,
 * поэтому здесь: три символа, цена и растёт и падает, `changePercent` меняет
 * знак, значения не по центру диапазона, и ни одно из них не ноль — ноль со
 * знаком и цветом читается потребителем как утверждение о рынке.
 *
 * Переключатели (чтобы ломать именно то, что проверяется):
 *   FAKE_BINANCE_PORT=18765   порт HTTP и WS (один и тот же)
 *   FAKE_BINANCE_SILENT=1     соединение принимается, кадров нет вовсе —
 *                             это half-open, его ловит таймер тишины
 *   FAKE_BINANCE_GARBAGE=1    перед тиками шлёт мусорный кадр
 *   FAKE_BINANCE_TICK_MS=200  период тика
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.FAKE_BINANCE_PORT ?? 18765);
const TICK_MS = Number(process.env.FAKE_BINANCE_TICK_MS ?? 200);
const SILENT = process.env.FAKE_BINANCE_SILENT === '1';
const GARBAGE = process.env.FAKE_BINANCE_GARBAGE === '1';

/**
 * Вселенная поддельного апстрима.
 *
 * `FAKEUSDT` — метка подделки. `BTCUSDT` и `ETHUSDT` есть и у боевого, они
 * нужны, чтобы контрактный прогон шёл по тем же путям, что боевой: символы
 * из каталога, маршрутизация, провенанс.
 */
const SYMBOLS = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', tickSize: '0.01000000' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', tickSize: '0.01000000' },
  { symbol: 'FAKEUSDT', baseAsset: 'FAKE', tickSize: '0.01000000' },
];

/**
 * Серия цен. Числа фиксированные и как рынок неправдоподобные, но как число
 * совершенно валидные: перепутать такой прогон с живым нельзя, а проверка
 * «цена больше тысячи» на них осмысленна.
 *
 * Цена и растёт и падает, знак `changePercent` меняется, нулей нет: иначе
 * ветви, считающие изменение, не выполняются ни разу и тест зелен при любой
 * формуле.
 */
const SERIES = {
  BTCUSDT: [
    { c: '12345.67', P: '1.25' },
    { c: '12300.00', P: '-0.80' },
    { c: '12400.50', P: '0.40' },
    { c: '12280.25', P: '-1.33' },
  ],
  ETHUSDT: [
    { c: '2345.50', P: '-2.10' },
    { c: '2360.75', P: '0.65' },
    { c: '2330.25', P: '-1.00' },
    { c: '2375.00', P: '1.87' },
  ],
  // Метка подделки: единственный неподвижный ряд. Ноль сюда не ставится
  // сознательно — нулевое изменение потребитель красит как «рынок стоял».
  FAKEUSDT: [{ c: '777.77', P: '0.11' }],
};

/** Что знает контрактный смоук про эту подделку. Держим в одном месте. */
export const FAKE_MARKER = { symbol: 'FAKEUSD', price: 777.77, changePercent: 0.11 };

const exchangeInfo = {
  timezone: 'UTC',
  symbols: SYMBOLS.map((s) => ({
    symbol: s.symbol,
    baseAsset: s.baseAsset,
    quoteAsset: 'USDT',
    status: 'TRADING',
    isSpotTradingAllowed: true,
    filters: [{ filterType: 'PRICE_FILTER', tickSize: s.tickSize }],
  })),
};

const http = createServer((req, res) => {
  if ((req.url ?? '').startsWith('/api/v3/exchangeInfo')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(exchangeInfo));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'поддельный апстрим такой ручки не знает' }));
});

// MDS подключается на `${BINANCE_WS_URL}/ws` — путь тот же, что у боевого.
const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', (socket) => {
  /** Подписанные стримы вида `btcusdt@ticker`. */
  const streams = new Set();
  let step = 0;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.method === 'SUBSCRIBE') for (const p of msg.params ?? []) streams.add(p);
    if (msg.method === 'UNSUBSCRIBE') for (const p of msg.params ?? []) streams.delete(p);
    // Ack подписки. Боевой отвечает так же, и наш провайдер обязан НЕ
    // считать этот кадр признаком жизни: он кадр, но не котировка.
    socket.send(JSON.stringify({ result: null, id: msg.id ?? null }));
  });

  if (SILENT) {
    // Соединение принято, кадров нет. Сокет цел, данных нет, `close` не
    // придёт никогда — это half-open, и его обязан поймать таймер тишины.
    console.info('[fake-binance] режим тишины: соединение принято, кадров не будет');
    return;
  }

  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (GARBAGE) socket.send('это не json');
    for (const stream of streams) {
      const pair = stream.split('@')[0]?.toUpperCase();
      const series = SERIES[pair];
      if (!series) continue;
      const point = series[step % series.length];
      socket.send(
        JSON.stringify({ e: '24hrTicker', E: Date.now(), s: pair, c: point.c, P: point.P }),
      );
    }
    step += 1;
  }, TICK_MS);
  timer.unref?.();
  socket.on('close', () => clearInterval(timer));
});

http.listen(PORT, '127.0.0.1', () => {
  console.info(
    `[fake-binance] ПОДДЕЛЬНЫЙ апстрим на 127.0.0.1:${PORT} — ` +
      `exchangeInfo (${SYMBOLS.length} пар, среди них метка FAKEUSDT) и WS /ws. ` +
      'Цены фиксированные и рынком не являются.',
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    wss.close();
    http.close(() => process.exit(0));
  });
}

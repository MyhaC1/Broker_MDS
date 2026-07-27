/** Конфигурация MDS. Всё через env, дефолты — локальный dev. */
export const config = {
  port: Number(process.env.PORT ?? 3003),
  /** Период батча quotes:batch на клиента (контракт драйвера сайта: ~250 мс) */
  batchMs: Number(process.env.BATCH_MS ?? 250),
  binanceWsUrl: process.env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443',
};

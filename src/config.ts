/** Конфигурация MDS. Всё через env, дефолты — локальный dev. */
export const config = {
  port: Number(process.env.PORT ?? 3003),
  /** CMS — источник каталога инструментов (канонические символы платформы) */
  cmsApiUrl: (process.env.CMS_API_URL ?? 'http://localhost:3001/v1').replace(/\/$/, ''),
  cmsApiKey: process.env.CMS_API_KEY ?? '',
  /** Период обновления каталога из CMS */
  catalogRefreshMs: Number(process.env.CATALOG_REFRESH_MS ?? 300_000),
  /** Период батча quotes:batch на клиента (контракт драйвера сайта: ~250 мс) */
  batchMs: Number(process.env.BATCH_MS ?? 250),
  binanceWsUrl: process.env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443',
};

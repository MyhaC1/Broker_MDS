/** Конфигурация MDS. Всё через env, дефолты — локальный dev. */
export const config = {
  port: Number(process.env.PORT ?? 3003),
  /** Период батча quotes:batch на клиента (контракт драйвера сайта: ~250 мс) */
  batchMs: Number(process.env.BATCH_MS ?? 250),
  binanceWsUrl: process.env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443',

  /**
   * Twelve Data (форекс/металлы/акции/индексы). Ключ живёт ТОЛЬКО здесь
   * (смысл MDS). Без ключа инструменты этого провайдера выпадают из
   * вселенной — сервис работает как раньше.
   * Бюджет кредитов = тариф ключа: free 8/мин и 800/день; PRO-ключ →
   * поднять env, поллер ускорится сам (1 символ в запросе = 1 кредит).
   */
  twelveData: {
    apiKey: process.env.TWELVEDATA_API_KEY ?? '',
    apiUrl: process.env.TWELVEDATA_API_URL ?? 'https://api.twelvedata.com',
    creditsPerMin: Number(process.env.TWELVEDATA_CREDITS_PER_MIN ?? 8),
    creditsPerDay: Number(process.env.TWELVEDATA_CREDITS_PER_DAY ?? 800),
  },
};

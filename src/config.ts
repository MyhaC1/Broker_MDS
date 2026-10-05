/** Конфигурация MDS. Всё через env, дефолты — локальный dev. */

/**
 * Целое положительное число из env — или `null`, если переменной нет либо
 * значение непригодно. Отдельная функция, потому что `Number(undefined)`
 * даёт `NaN`, а `Number('')` — **0**: пустая переменная превратилась бы в
 * «порог ноль», то есть в «протухло всё». Правило платформы: успешный
 * разбор не означает пригодного значения.
 */
export function positiveIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3003),
  /** Период батча quotes:batch на клиента (контракт драйвера сайта: ~250 мс) */
  batchMs: Number(process.env.BATCH_MS ?? 250),
  binanceWsUrl: process.env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443',
  /** REST Binance для автозагрузки каталога (exchangeInfo). */
  binanceApiUrl: process.env.BINANCE_API_URL ?? 'https://api.binance.com',

  /**
   * Порог свежести котировки, мс. **Умолчания нет и не будет** — КОНТРАКТЫ.md
   * §5г, требование 1. Порог — утверждение о том, какая цена ещё считается
   * текущей; выдуманный в коде, он молча разойдётся с порогом потребителя, и
   * обе стороны будут «правы».
   *
   * Не задан → MDS не знает, что свежо, и **не отдаёт котировок вовсе**
   * (`items: []`, `staleAfterMs: null`, `staleSymbols: null`, `/health` 503).
   * Это fail-closed по образцу §4б: отказ конфигурации не должен превращаться
   * в разрешение показывать старую цену как текущую.
   *
   * Это НЕ то же самое, что `providerSilenceMs` ниже: там — когда считать
   * мёртвым соединение, здесь — когда считать мёртвой цену.
   */
  staleAfterMs: positiveIntOrNull(process.env.QUOTE_STALE_AFTER_MS),

  /**
   * Таймер тишины провайдера, мс: столько без **опознанного** тика — и
   * соединение считается мёртвым независимо от того, что говорит сокет
   * (B-003, half-open TCP; «отсутствие события не является событием»).
   * Умолчание здесь допустимо и осознанно: это внутренняя политика
   * переподключения, наружу она ничего не утверждает. 30 с — с запасом,
   * Binance `@ticker` пушит по каждому стриму примерно раз в секунду.
   */
  providerSilenceMs: Number(process.env.PROVIDER_SILENCE_MS ?? 30_000),

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

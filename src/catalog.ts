import { z } from 'zod';
import { config } from './config.js';
import type { CatalogInstrument } from './types.js';

/**
 * Каталог инструментов: канонические символы платформы — из CMS
 * (`/v1/cms/instruments`, домен CMS по ADR-024), маппинг на провайдера — здесь.
 * MVP: крипта через Binance (BTCUSD → btcusdt). Прочие категории появятся
 * с платными провайдерами (проверка лицензий — риск R-T5).
 * CMS недоступна → статический фолбэк (сервис живёт без соседей).
 */

const cmsInstrumentSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1),
  category: z.enum(['forex', 'metals', 'crypto', 'indices', 'stocks', 'energy']),
  digits: z.number().int().min(0).max(8),
});
const cmsResponseSchema = z.object({ items: z.array(cmsInstrumentSchema.passthrough()) });

/** Канонический крипто-символ платформы → символ Binance. */
export function binanceSymbolFor(canonical: string): string {
  return canonical.replace(/USD$/, 'USDT').toLowerCase();
}

export function toCatalog(items: z.infer<typeof cmsInstrumentSchema>[]): CatalogInstrument[] {
  return items
    .filter((i) => i.category === 'crypto')
    .map((i) => ({
      symbol: i.symbol,
      name: i.name,
      category: i.category,
      digits: i.digits,
      provider: 'binance' as const,
      providerSymbol: binanceSymbolFor(i.symbol),
    }));
}

/** Фолбэк на случай недоступной CMS при старте — крипта из эталонных фикстур. */
export const FALLBACK_CATALOG: CatalogInstrument[] = toCatalog([
  { symbol: 'BTCUSD', name: 'Bitcoin', category: 'crypto', digits: 0 },
  { symbol: 'ETHUSD', name: 'Ethereum', category: 'crypto', digits: 1 },
  { symbol: 'SOLUSD', name: 'Solana', category: 'crypto', digits: 2 },
  { symbol: 'XRPUSD', name: 'Ripple', category: 'crypto', digits: 4 },
  { symbol: 'BNBUSD', name: 'BNB', category: 'crypto', digits: 1 },
]);

export async function fetchCatalog(): Promise<CatalogInstrument[]> {
  const res = await fetch(`${config.cmsApiUrl}/cms/instruments?locale=ru`, {
    headers: config.cmsApiKey ? { 'X-API-Key': config.cmsApiKey } : {},
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`CMS instruments: HTTP ${res.status}`);
  const parsed = cmsResponseSchema.parse(await res.json());
  const catalog = toCatalog(parsed.items);
  if (catalog.length === 0) throw new Error('CMS catalog has no crypto instruments');
  return catalog;
}

export interface CatalogState {
  instruments: CatalogInstrument[];
  source: 'cms' | 'fallback';
  updatedAt: number;
}

/** Загрузка с фолбэком + периодический рефреш; onChange зовётся при смене состава. */
export function startCatalog(onChange: (state: CatalogState) => void): { current: () => CatalogState } {
  let state: CatalogState = { instruments: FALLBACK_CATALOG, source: 'fallback', updatedAt: Date.now() };

  const load = async () => {
    try {
      const instruments = await fetchCatalog();
      const changed = JSON.stringify(instruments) !== JSON.stringify(state.instruments);
      state = { instruments, source: 'cms', updatedAt: Date.now() };
      if (changed) onChange(state);
    } catch (error) {
      console.warn('[catalog] CMS unavailable, keeping current catalog:', (error as Error).message);
    }
  };

  void load().then(() => onChange(state));
  const timer = setInterval(load, config.catalogRefreshMs);
  timer.unref();

  return { current: () => state };
}

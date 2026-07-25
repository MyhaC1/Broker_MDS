/** Контракт котировки — 1:1 с Quote из packages/realtime сайта (FeedDriver). */
export interface Quote {
  symbol: string;
  name: string;
  category: 'forex' | 'metals' | 'crypto' | 'indices' | 'stocks' | 'energy';
  price: number;
  digits: number;
  changePercent: number;
  /** Unix ms последнего обновления */
  ts: number;
}

/** Инструмент каталога: канонический символ платформы + маппинг на провайдера. */
export interface CatalogInstrument {
  symbol: string;
  name: string;
  category: Quote['category'];
  digits: number;
  provider: 'binance';
  providerSymbol: string;
}

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

/**
 * Сегмент внутри категории (таксономия платформы):
 * акции и индексы — по регионам (Европа/Азия/Америка/РФ),
 * валюта — по ликвидности (мажоры/миноры/экзотика).
 * Сырьё сегментов не имеет — «все возможные активы» одной группой
 * (metals/energy уже разведены на уровне category).
 */
export type Segment = 'europe' | 'asia' | 'america' | 'rf' | 'major' | 'minor' | 'exotic';

/** Инструмент каталога: канонический символ платформы + маппинг на провайдера. */
export interface CatalogInstrument {
  symbol: string;
  name: string;
  category: Quote['category'];
  /** null — категория без сегментов (крипта) */
  segment: Segment | null;
  digits: number;
  provider: 'binance' | 'twelvedata';
  providerSymbol: string;
}

import { describe, expect, it } from 'vitest';
import { binanceSymbolFor, CATALOG, digitsFromTickSize } from './catalog.js';
import { normalizeTick } from './providers/binance.js';
import type { CatalogInstrument } from './types.js';

describe('вселенная инструментов', () => {
  it('канонический USD → binance USDT lowercase', () => {
    expect(binanceSymbolFor('BTCUSD')).toBe('btcusdt');
    expect(binanceSymbolFor('XRPUSD')).toBe('xrpusdt');
  });

  it('digitsFromTickSize: число знаков из tickSize', () => {
    expect(digitsFromTickSize('0.01000000')).toBe(2);
    expect(digitsFromTickSize('0.00010000')).toBe(4);
    expect(digitsFromTickSize('1.00000000')).toBe(0);
    expect(digitsFromTickSize('0.00000001')).toBe(8);
  });

  it('каталог статический, два провайдера, символы уникальны', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(29);
    expect(new Set(CATALOG.map((i) => i.symbol)).size).toBe(CATALOG.length);
    const crypto = CATALOG.filter((i) => i.category === 'crypto');
    expect(crypto.length).toBeGreaterThanOrEqual(12);
    expect(crypto.every((i) => i.provider === 'binance')).toBe(true);
    const twelve = CATALOG.filter((i) => i.provider === 'twelvedata');
    expect(twelve.length).toBeGreaterThanOrEqual(17);
    // Заявленная таксономия присутствует
    const has = (category: string, segment: string | null) =>
      CATALOG.some((i) => i.category === category && i.segment === segment);
    expect(has('forex', 'major') && has('forex', 'minor') && has('forex', 'exotic')).toBe(true);
    expect(has('stocks', 'america')).toBe(true);
    expect(has('indices', 'america') && has('indices', 'europe')).toBe(true);
    expect(has('metals', null)).toBe(true);
  });

  it('метка группы: категория и категория — сегмент', async () => {
    const { groupLabelFor } = await import('./catalog.js');
    expect(groupLabelFor({ category: 'crypto', segment: null })).toBe('Криптовалюты');
    expect(groupLabelFor({ category: 'stocks', segment: 'europe' })).toBe('Акции — Европа');
    expect(groupLabelFor({ category: 'forex', segment: 'exotic' })).toBe('Валюта — Экзотика');
    expect(groupLabelFor({ category: 'indices', segment: 'rf' })).toBe('Индексы — РФ');
  });

  it('у каждого инструмента вселенной есть иконка в public/icons', async () => {
    const { iconPathFor } = await import('./icons.js');
    for (const i of CATALOG) {
      expect(iconPathFor(i.symbol), i.symbol).toBe(`/icons/${i.symbol}.svg`);
    }
  });
});

describe('normalizeTwelveQuote (Twelve Data /quote → Quote контракта сайта)', () => {
  it('нормализует ответ /quote', async () => {
    const { normalizeTwelveQuote } = await import('./providers/twelvedata.js');
    const eurusd = CATALOG.find((i) => i.symbol === 'EURUSD')!;
    const quote = normalizeTwelveQuote(
      { symbol: 'EUR/USD', close: '1.08543', percent_change: '-0.25', timestamp: 1784990000 },
      eurusd,
      'twelvedata',
    );
    expect(quote).toEqual({
      symbol: 'EURUSD',
      name: 'EUR/USD',
      category: 'forex',
      price: 1.08543,
      digits: 5,
      changePercent: -0.25,
      // Лучших цен источник не даёт вовсе — пустота, а не ноль (MDS-12).
      // Это заявление: живой ответ `/quote` от 25.10 их не нёс, и в их
      // спецификации `bid`/`ask` есть только в цепочке опционов.
      bid: null,
      ask: null,
      ts: 1784990000000,
      source: 'twelvedata',
    });
  });

  it('мусорная цена отбрасывается; отсутствующий percent_change — тоже (QA-05)', async () => {
    const { normalizeTwelveQuote } = await import('./providers/twelvedata.js');
    const eurusd = CATALOG.find((i) => i.symbol === 'EURUSD')!;
    expect(normalizeTwelveQuote({ close: 'abc' }, eurusd, 'twelvedata')).toBeNull();
    // До 20.10 здесь ожидался `changePercent === 0`. Отменено: поле
    // окрашивается, и ноль со знаком читается как утверждение о рынке.
    expect(
      normalizeTwelveQuote({ close: '1.1', timestamp: 1784990000 }, eurusd, 'twelvedata'),
    ).toBeNull();
  });
});

describe('normalizeTick (Binance @ticker → Quote контракта сайта)', () => {
  const bySymbol = new Map<string, CatalogInstrument>(CATALOG.map((i) => [i.providerSymbol, i]));

  it('нормализует тик в канонический Quote', () => {
    const quote = normalizeTick(
      { e: '24hrTicker', E: 1784990000000, s: 'BTCUSDT', c: '64034.52', P: '-1.497' },
      bySymbol,
      'binance',
    );
    expect(quote).toEqual({
      symbol: 'BTCUSD',
      name: 'Bitcoin',
      category: 'crypto',
      price: 64034.52,
      digits: 0,
      changePercent: -1.497,
      // Кадра без `b`/`a` на живом проводе мы не наблюдали ни разу, но
      // «не наблюдали» — не «не бывает»: поля необязательные, и путь без
      // них обязан проходиться.
      bid: null,
      ask: null,
      ts: 1784990000000,
      source: 'binance',
    });
  });

  it('неизвестный символ и мусорные числа отбрасываются', () => {
    expect(normalizeTick({ e: '24hrTicker', E: 1, s: 'PEPEUSDT', c: '1', P: '1' }, bySymbol, 'binance')).toBeNull();
    expect(normalizeTick({ e: '24hrTicker', E: 1, s: 'BTCUSDT', c: 'abc', P: '1' }, bySymbol, 'binance')).toBeNull();
  });

  /*
    Лучшие цены (MDS-12).

    Образец — НАСТОЯЩИЙ кадр, снятый 25.10 с
    `wss://stream.binance.com:9443/ws`, а не собранный нами. Поэтому в нём
    стоят поля, которых разборщик не читает (`p`, `w`, `o`, `n` и прочие):
    они тут не для красоты — именно так выглядит то, что приходит, и
    именно на таком кадре надо показывать, что лишнее не мешает, а нужное
    берётся.
  */
  const LIVE_FRAME = {
    e: '24hrTicker',
    E: 1792933166015,
    s: 'BTCUSDT',
    p: '-340.20000000',
    P: '-0.421',
    w: '80249.65495312',
    x: '80790.26000000',
    c: '80450.06000000',
    Q: '0.00097000',
    b: '80450.06000000',
    B: '8.44761000',
    a: '80450.07000000',
    A: '0.44922000',
    o: '80790.26000000',
    h: '81033.69000000',
    l: '79220.74000000',
    v: '9653.49069000',
    q: '774689296.96564170',
    O: 1792846766005,
    C: 1792933166005,
    F: 6788292805,
    L: 6789854066,
    n: 1561262,
  };

  it('ЖИВОЙ кадр: лучшие цены берутся из b/a, лишние поля не мешают', () => {
    const quote = normalizeTick(LIVE_FRAME, bySymbol, 'binance');
    expect(quote?.bid).toBe(80450.06);
    expect(quote?.ask).toBe(80450.07);
    // И цена осталась ценой: `b` совпадает с `c` в этом кадре, поэтому
    // перепутать их местами здесь нельзя — проверяем `ask`, который
    // отличается от обоих.
    expect(quote?.price).toBe(80450.06);
  });

  it('поля нет → пустота, и тик НЕ отбрасывается: цена известна, стакан нет', () => {
    const { b: _b, a: _a, ...noBook } = LIVE_FRAME;
    const quote = normalizeTick(noBook, bySymbol, 'binance');
    expect(quote).not.toBeNull();
    expect(quote?.price).toBe(80450.06);
    expect(quote?.bid).toBeNull();
    expect(quote?.ask).toBeNull();
  });

  it('ноль и отрицательное отвергаются КАК ЗНАЧЕНИЕ, а не подставляются', () => {
    // Нулевая цена покупки означала бы сделку по нулю. Отрицательная — то
    // же с другой стороны. Ни то, ни другое не «спред нулевой».
    const zero = normalizeTick({ ...LIVE_FRAME, b: '0', a: '0.00000000' }, bySymbol, 'binance');
    expect(zero?.bid).toBeNull();
    expect(zero?.ask).toBeNull();
    const negative = normalizeTick({ ...LIVE_FRAME, b: '-1.5' }, bySymbol, 'binance');
    expect(negative?.bid).toBeNull();
    // Вторая сторона при этом остаётся годной: барьеры у них раздельные.
    expect(negative?.ask).toBe(80450.07);
  });

  it('мусор в b не трогает ни цену, ни вторую сторону стакана', () => {
    const quote = normalizeTick({ ...LIVE_FRAME, b: 'абв' }, bySymbol, 'binance');
    expect(quote?.price).toBe(80450.06);
    expect(quote?.changePercent).toBe(-0.421);
    expect(quote?.bid).toBeNull();
    expect(quote?.ask).toBe(80450.07);
  });

  it('перекрещённый стакан снимает ОБЕ стороны, а не выбирает наугад', () => {
    // При `bid > ask` известно, что одна из величин неверна, и неизвестно
    // какая. Оставить «похожую на правду» значило бы выдать выбор за
    // знание. На живом рынке не встретилось ни разу (0 из 471 кадра).
    const quote = normalizeTick({ ...LIVE_FRAME, b: '80451', a: '80450' }, bySymbol, 'binance');
    expect(quote).not.toBeNull();
    expect(quote?.bid).toBeNull();
    expect(quote?.ask).toBeNull();
  });
});

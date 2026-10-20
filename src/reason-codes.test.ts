import { describe, expect, it } from 'vitest';
import { UNAVAILABLE_REASONS } from './api.js';
import { ROUTE_REASONS } from './registry.js';
import { ADMIN_CODES, UNAUTHORIZED_DETAILS } from './admin.js';

/**
 * Словари машинных причин. Проверяется не «работает ли код», а **стиль и
 * состав перечня** — то, из-за чего два похожих словаря расходятся молча и
 * одно состояние получает два имени (Р-087, `_brain/КОНТРАКТЫ.md` §4г).
 *
 * Эталон здесь выписан **из контракта, а не снят с кода**: ожидания, снятые
 * с реализации, закрепляют её ошибку и остаются зелёными навсегда. Если
 * перечень в коде разойдётся с §4г — краснеет этот тест, а не потребитель
 * через месяц.
 *
 * Тест-растяжка: он не проверяет поведение, он **делает видимой связь** между
 * кодом и решением штаба. Тот, кто решит завести восьмую причину прямо в
 * коде, увидит здесь, что имя заводится в §4г.
 */

/** kebab-case: строчные латинские слова через дефис, без цифр по краям. */
const KEBAB = /^[a-z]+(-[a-z]+)*$/;

/**
 * Ось символа — ровно как в `_brain/КОНТРАКТЫ.md` §4г, переписано оттуда
 * руками. Порядок здесь не важен, состав важен.
 */
const CONTRACT_SYMBOL_AXIS = [
  'registry-unreadable',
  'no-source',
  'source-disabled',
  'source-silent',
  'stale',
  'not-in-catalog',
  'threshold-unset',
];

/**
 * Ось канала — её называет **потребитель**, не мы. Перечень здесь для того,
 * чтобы было чем утверждать: ни одно из этих имён не должно оказаться в
 * нашей оси символа. Два словаря, схлопнутые в один, — это и есть то, что
 * §4г запрещает.
 */
const CONSUMER_CHANNEL_AXIS = ['not-configured', 'network', 'http-error', 'malformed', 'empty'];

describe('Словари машинных причин · стиль и состав (Р-087, §4г)', () => {
  it('ось символа совпадает с §4г по составу — ни лишних имён, ни забытых', () => {
    expect([...UNAVAILABLE_REASONS].sort()).toEqual([...CONTRACT_SYMBOL_AXIS].sort());
  });

  it('ось символа — kebab-case во всех именах', () => {
    const wrong = UNAVAILABLE_REASONS.filter((code) => !KEBAB.test(code));
    expect(wrong).toEqual([]);
  });

  it('причины маршрутизации — kebab-case: они уходят наружу в coverage.byReason', () => {
    const wrong = ROUTE_REASONS.filter((code) => !KEBAB.test(code));
    expect(wrong).toEqual([]);
  });

  it('коды служебной ручки — kebab-case, включая уточнение к unauthorized', () => {
    const wrong = [...ADMIN_CODES, ...UNAUTHORIZED_DETAILS].filter((code) => !KEBAB.test(code));
    expect(wrong).toEqual([]);
  });

  it('ось символа и ось канала не пересекаются: одно состояние — одно имя', () => {
    const overlap = UNAVAILABLE_REASONS.filter((code) =>
      (CONSUMER_CHANNEL_AXIS as string[]).includes(code),
    );
    expect(overlap).toEqual([]);
  });

  it('общие имена двух наших осей значат одно и то же, а не разное', () => {
    // `source-disabled` и `no-source` есть и в маршрутизации, и в ответе
    // `/v1/quotes` — это сознательно одно состояние под одним именем.
    // Любое ДРУГОЕ совпадение имён между осями — повод остановиться: два
    // словаря с общим словом и разным смыслом расходятся молча.
    const shared = ROUTE_REASONS.filter((code) =>
      (UNAVAILABLE_REASONS as readonly string[]).includes(code),
    );
    expect([...shared].sort()).toEqual(['no-source', 'source-disabled']);
  });
});

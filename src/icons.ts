import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Иконки монет вселенной (public/icons/<SYMBOL>.svg, набор MIT
 * cryptocurrency-icons). Раздаются по GET /icons/<SYMBOL>.svg; в
 * /v1/instruments каждый инструмент несёт относительный путь `icon` —
 * потребитель (CMS, сайт) префиксует его своим базовым URL MDS.
 * SVG маленькие и неизменяемые в рамках деплоя — держим в памяти.
 */

const ICONS_DIR = join(process.cwd(), 'public', 'icons');

const cache = new Map<string, Buffer>();
try {
  for (const file of readdirSync(ICONS_DIR)) {
    if (file.endsWith('.svg')) {
      cache.set(file.slice(0, -4), readFileSync(join(ICONS_DIR, file)));
    }
  }
} catch {
  console.warn('[mds] public/icons отсутствует — инструменты без иконок');
}

/** Относительный путь иконки для /v1/instruments (null — иконки нет). */
export function iconPathFor(symbol: string): string | null {
  return cache.has(symbol) ? `/icons/${symbol}.svg` : null;
}

/** Содержимое SVG для HTTP-раздачи (null — 404). */
export function iconSvg(symbol: string): Buffer | null {
  return cache.get(symbol) ?? null;
}

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { builtinRegistry, registrySchema, type Registry } from './registry.js';

/**
 * Хранение реестра провайдеров. MDS stateless по котировкам, но реестр —
 * **настраиваемое состояние, которое обязано пережить рестарт**: иначе
 * переключатель в админке работает до первого деплоя, а потом молча
 * возвращает всё к умолчанию.
 *
 * Три исхода загрузки, и они **разные состояния, ни одно из которых не
 * «пусто»**:
 *
 *  - `builtin-default` — файла нет. Это первый запуск: работаем по
 *    умолчанию, но умолчание **называет себя умолчанием** везде, где
 *    показывается. Файл при этом НЕ создаётся: созданный на старте файл
 *    сделал бы «никто не настраивал» неотличимым от «настроили ровно так».
 *  - `file` — файл прочитан и разобран. Состояние выбрано оператором.
 *  - `error` — файл есть, но прочитать или разобрать его не удалось.
 *    **Это не повод взять умолчание.** Умолчание здесь означало бы: цены
 *    идут из источников, которых никто не выбирал, причём молча. Сервис
 *    поднимается, провайдеров не запускает, котировок не отдаёт, `/health`
 *    отвечает 503 с названной причиной — fail-closed по образцу §4б.
 */
export type RegistryOrigin = 'builtin-default' | 'file' | 'error';

export interface LoadedRegistry {
  origin: RegistryOrigin;
  /** `null` ровно и только при `origin === 'error'`. Отказ ≠ пустой реестр. */
  registry: Registry | null;
  /** Человекочитаемая причина при `error`; в остальных случаях `undefined`. */
  error?: string;
  path: string;
}

/** Читает реестр. Никогда не бросает: отказ — это состояние, а не исключение. */
export function loadRegistry(path: string): LoadedRegistry {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { origin: 'builtin-default', registry: builtinRegistry(), path };
    }
    // Права, каталог вместо файла, сбой диска — файл есть, но он нам не
    // дался. Подставить умолчание здесь значило бы выдать неизвестное за
    // выбранное.
    return { origin: 'error', registry: null, error: `${code ?? 'IO'}: ${(error as Error).message}`, path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { origin: 'error', registry: null, error: `JSON: ${(error as Error).message}`, path };
  }

  const result = registrySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`)
      .join('; ');
    return { origin: 'error', registry: null, error: `схема: ${issues}`, path };
  }

  return { origin: 'file', registry: result.data, path };
}

/**
 * Запись реестра. Через временный файл и `rename`: оборванная на середине
 * запись оставила бы обрезанный JSON, то есть перевела бы сервис в `error`
 * при следующем рестарте — отказ, отложенный до момента, когда причину уже
 * никто не свяжет с правкой.
 */
export function saveRegistry(path: string, registry: Registry): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

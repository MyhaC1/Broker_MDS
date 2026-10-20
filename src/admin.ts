import { timingSafeEqual } from 'node:crypto';
import { registrySchema, summarizeRouting, type Registry, type RoutingTable } from './registry.js';
import type { RegistryOrigin } from './registry-store.js';

/**
 * Служебная ручка управления реестром провайдеров (Р-047).
 *
 * **Она меняет регуляторно значимое состояние** — какой источник формирует
 * цену, по которой считаются P&L, маржа и срабатывание стопов. Поэтому здесь
 * нет ни одной ветки, в которой непонятный запрос выполняется «как
 * получится»: неизвестный исход — всегда отказ с названным кодом.
 *
 * **Чем закрыта и чем НЕ закрыта.** Закрыта общим секретом
 * (`MDS_ADMIN_TOKEN`), сверяемым за постоянное время, и только
 * сервер-сервером: на путях `/v1/admin/*` заголовка `Access-Control-Allow-Origin`
 * нет вовсе, а preflight отбивается — из браузера ручка недоступна.
 *
 * Чего общий секрет не даёт, и это надо произносить вслух, а не
 * подразумевать:
 *  - он **не личность**: в журнале останется «кто-то со знанием секрета», а
 *    не «администратор такой-то». Поле `updatedBy` заполняет вызывающий, и
 *    оно является утверждением вызывающего, а не проверенным фактом;
 *  - **ротации нет**: секрет один, смена требует перезапуска обеих сторон;
 *  - **сеть не ограничена**: серверной проверки доступа у MDS нет вовсе
 *    (ПРОДАКШЕН.md), и после выноса наружу секрет останется единственным
 *    барьером. До выноса наружу — ограничение принято сознательно.
 */

export type AuthOutcome =
  /** Секрет совпал. */
  | { ok: true }
  /**
   * Секрет не настроен или настроен непригодным. Ручка **выключена целиком**,
   * а не открыта: не настроенная защита обязана давать отказ, а не проход.
   * Код отличается от `unauthorized` намеренно — «ручка выключена» и «вас не
   * пустили» разные диагнозы, и путать их значит отправлять чинить не то.
   */
  | { ok: false; code: Extract<AdminCode, 'control-plane-disabled'>; status: 503; detail: string }
  | { ok: false; code: Extract<AdminCode, 'unauthorized'>; status: 401; detail: UnauthorizedDetail };

/**
 * Все машинные коды отказа служебной ручки, перечнем, который видно в
 * рантайме. Перечисление в типе компилятор стирает — проверить стиль или
 * сверить с контрактом по нему нельзя, а перечень руками рядом с типом
 * отстаёт молча (так уже отставал перечень полей в комплаенсе CMS).
 *
 * Стиль — kebab-case, один на платформу (Р-087, `_brain/КОНТРАКТЫ.md` §4г).
 * Это **третья** ось, в §4г не названная: ось символа говорит, почему нет
 * цены, ось канала — почему потребитель не получил ответа, а эта — почему
 * MDS отказал в запросе к служебной ручке.
 */
export const ADMIN_CODES = [
  'control-plane-disabled',
  'unauthorized',
  'registry-unreadable',
  'bad-body',
  'version-required',
  'version-conflict',
  'invalid-registry',
  'method-not-allowed',
  'not-found',
] as const;

export type AdminCode = (typeof ADMIN_CODES)[number];

/** Уточнение к `unauthorized`: заголовка не было или он не тот. */
export const UNAUTHORIZED_DETAILS = ['no-token', 'bad-token'] as const;

export type UnauthorizedDetail = (typeof UNAUTHORIZED_DETAILS)[number];

/** Короткий секрет создаёт видимость защиты, поэтому он не секрет, а ошибка настройки. */
export const MIN_ADMIN_TOKEN_LENGTH = 24;

export function authorize(header: string | string[] | undefined, configured: string | undefined): AuthOutcome {
  if (configured === undefined || configured.trim() === '') {
    return {
      ok: false,
      code: 'control-plane-disabled',
      status: 503,
      detail: 'MDS_ADMIN_TOKEN не задан — служебная ручка выключена',
    };
  }
  // Секрет едет HTTP-заголовком, а заголовок — байты латиницы. Непечатный
  // или не-ASCII секрет клиент физически не сможет прислать: сравнение
  // никогда не сойдётся, и выглядело бы это как «секрет неверный», то есть
  // отправляло бы чинить не то. Поймано живым прогоном, не рассуждением.
  if (!/^[!-~]+$/.test(configured)) {
    return {
      ok: false,
      code: 'control-plane-disabled',
      status: 503,
      detail: 'MDS_ADMIN_TOKEN содержит символы, непередаваемые в HTTP-заголовке (нужен ASCII без пробелов)',
    };
  }
  if (configured.length < MIN_ADMIN_TOKEN_LENGTH) {
    return {
      ok: false,
      code: 'control-plane-disabled',
      status: 503,
      detail: `MDS_ADMIN_TOKEN короче ${MIN_ADMIN_TOKEN_LENGTH} символов — считаем настройку непригодной`,
    };
  }
  const supplied = Array.isArray(header) ? header[0] : header;
  if (supplied === undefined || supplied === '') {
    return { ok: false, code: 'unauthorized', status: 401, detail: 'no-token' };
  }
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(configured, 'utf8');
  // Длина утекает в любом случае (она видна по времени сравнения буферов
  // разной длины), поэтому сравниваем её отдельно и явно, а содержимое — за
  // постоянное время.
  const equal = a.length === b.length && timingSafeEqual(a, b);
  return equal ? { ok: true } : { ok: false, code: 'unauthorized', status: 401, detail: 'bad-token' };
}

export interface AdminView {
  registry: Registry | null;
  /** Откуда взялось то, что сейчас действует. `builtin-default` = никто не выбирал. */
  origin: RegistryOrigin;
  /** Заполнено только при `origin === 'error'`. */
  error?: string;
  /** Перечень адаптеров, для которых в сервисе есть код (что можно включить вообще). */
  adapters: readonly string[];
  routing: ReturnType<typeof summarizeRouting> | null;
  /** Есть ли у источника ключ в окружении. Сам ключ не отдаётся никогда. */
  keys: { providerId: string; required: boolean; present: boolean }[];
}

export function buildAdminView(input: {
  registry: Registry | null;
  origin: RegistryOrigin;
  error?: string;
  adapters: readonly string[];
  routing: RoutingTable | null;
  keyPresence: Map<string, boolean>;
}): AdminView {
  return {
    registry: input.registry,
    origin: input.origin,
    ...(input.error === undefined ? {} : { error: input.error }),
    adapters: input.adapters,
    routing: input.routing ? summarizeRouting(input.routing) : null,
    keys: (input.registry?.providers ?? []).map((p) => ({
      providerId: p.id,
      required: p.requiresKey,
      present: input.keyPresence.get(p.id) ?? false,
    })),
  };
}

export type UpdateOutcome =
  | { ok: true; registry: Registry }
  | { ok: false; status: 400 | 409 | 503; code: AdminCode; detail: string };

/**
 * Приём изменения реестра. Чистая функция: вход — текущее состояние и тело
 * запроса, выход — либо новый реестр, либо названный отказ.
 *
 * `version` в теле обязателен и сверяется с действующей — это защита от
 * потерянного обновления: две вкладки админки, открытые на разных версиях,
 * иначе затёрли бы правки друг друга молча. Условие именно «совпадает», а не
 * «не меньше».
 */
export function applyRegistryUpdate(
  current: Registry | null,
  body: unknown,
  meta: { now: Date; actor: string },
): UpdateOutcome {
  if (current === null) {
    return {
      ok: false,
      status: 503,
      code: 'registry-unreadable',
      detail: 'действующий реестр не прочитан — чинить файл, а не писать поверх вслепую',
    };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'bad-body', detail: 'тело запроса — объект JSON' };
  }
  const incoming = body as Record<string, unknown>;
  if (typeof incoming.version !== 'number' || !Number.isInteger(incoming.version)) {
    return {
      ok: false,
      status: 400,
      code: 'version-required',
      detail: 'version обязателен: без него правка затирает чужую молча',
    };
  }
  if (incoming.version !== current.version) {
    return {
      ok: false,
      status: 409,
      code: 'version-conflict',
      detail: `реестр уже версии ${current.version}, прислана правка от ${incoming.version}`,
    };
  }

  const candidate = {
    ...incoming,
    version: current.version + 1,
    updatedAt: meta.now.toISOString(),
    updatedBy: meta.actor,
  };

  const parsed = registrySchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`)
      .join('; ');
    return { ok: false, status: 400, code: 'invalid-registry', detail: issues };
  }

  return { ok: true, registry: parsed.data };
}

/**
 * Запись журнала изменений. Регуляторно значимое состояние без следа
 * «кто, когда, с чего на что» непроверяемо — защита без наблюдаемого следа
 * непроверяема, и это то же правило, по которому мы требуем лог у разбора
 * токена.
 *
 * **Журнал в памяти и в stdout, не на диске.** Сознательно: сервис stateless,
 * а долговечный журнал — это отдельное хранилище и отдельное решение штаба.
 * Ограничение записано в отчёте и в долге, чтобы его не приняли за наличие
 * аудита.
 */
export interface AuditEntry {
  at: string;
  actor: string;
  remote: string;
  outcome: string;
  fromVersion: number | null;
  toVersion: number | null;
  changes: string[];
}

export function describeChanges(before: Registry | null, after: Registry): string[] {
  const out: string[] = [];
  const prev = new Map((before?.providers ?? []).map((p) => [p.id, p]));
  for (const p of after.providers) {
    const was = prev.get(p.id);
    if (!was) {
      out.push(`+${p.id} (adapter=${p.adapter}, enabled=${p.enabled}, priority=${p.priority})`);
      continue;
    }
    if (was.enabled !== p.enabled) out.push(`${p.id}: enabled ${was.enabled} → ${p.enabled}`);
    if (was.priority !== p.priority) out.push(`${p.id}: priority ${was.priority} → ${p.priority}`);
    if (was.covers.join(',') !== p.covers.join(',')) {
      out.push(`${p.id}: covers [${was.covers.join(',')}] → [${p.covers.join(',')}]`);
    }
    if (was.maxSilenceMs !== p.maxSilenceMs) {
      out.push(`${p.id}: maxSilenceMs ${was.maxSilenceMs} → ${p.maxSilenceMs}`);
    }
    prev.delete(p.id);
  }
  for (const id of prev.keys()) out.push(`-${id}`);
  if (before && before.categoryPrecedence.join(',') !== after.categoryPrecedence.join(',')) {
    out.push(`categoryPrecedence [${before.categoryPrecedence.join(',')}] → [${after.categoryPrecedence.join(',')}]`);
  }
  return out;
}

export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  constructor(private readonly limit = 200) {}

  record(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    console.info(
      `[mds:admin] ${entry.at} ${entry.outcome} actor=${entry.actor} remote=${entry.remote} ` +
        `v${entry.fromVersion} → v${entry.toVersion} ${entry.changes.join(' | ') || '(без изменений состава)'}`,
    );
  }

  list(): AuditEntry[] {
    return [...this.entries];
  }
}

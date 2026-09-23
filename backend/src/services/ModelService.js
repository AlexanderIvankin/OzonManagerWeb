const crypto = require('crypto');
const OfferModel = require('../models/OfferModel');
const StorageService = require('./StorageService');
const NotificationService = require('./NotificationService');
const OzonService = require('./OzonService');
const { getDB } = require('../config/database');
// Единый источник истины по ролям персонала (модуль без зависимостей).
const { STAFF_ROLES } = require('../config/staffRoles');

// ============================================================================
// ModelService — единая точка работы с 3D-моделями: обёртка над StorageService
// (S3 + локальный кэш) и БД (offer_models / issued_models / tokens).
//
// Принцип работы (zip-first):
//   • модель на артикул — ОДИН zip-архив в S3, файлы лежат в КОРНЕ бакета:
//     s3://bucket/{offer_id}.zip (например, ARD000003-N.zip);
//     при любом обновлении файлов перезаливается целиком новый zip;
//   • прямых ссылок на S3 нет: клиент запрашивает одноразовый токен
//     (POST /api/models/request/:offerId), затем скачивает файл по токену
//     (GET /api/models/download/:token); бэкенд отдаёт файл из локального кэша,
//     прогревая его из S3 при необходимости;
//   • при назначении заказа (OrderService.assignOrder) модели по составу заказа
//     записываются сотруднику в issued_models и приходит оповещение
//     «модели доступны»; сотруднику всегда уходит ТОТ ЖЕ актуальный zip;
//   • выдача учитывает родительский артикул: для ARD000003-NR/-NL ищется
//     модель родителя ARD000003-N (как в бот-версии, getParentOfferId).
//     Если по прямому артикулу модели не было, а выдали из родительского —
//     персоналу уходит отдельное оповещение (models_parent_used) с обоими
//     артикулами для идентификации.
//
// Валидация при загрузке (персонал):
//   • ЖЁСТКО: загружаемый файл обязан быть .zip (по расширению и magic-байтам) —
//     иначе загрузка отклоняется (на клиенте — live-тост с ошибкой);
//   • внутри zip: проверка расширений МЯГКАЯ — архив с «не-модельными» файлами
//     (.docx и т.п.) загружается, но список файлов моделей фиксируется в
//     оповещении/ответе (modelFiles); исполняемые файлы внутри zip ЗАПРЕЩЕНЫ.
// ============================================================================
// Расширения, которые считаем «файлами моделей» внутри zip — МЯГКАЯ проверка
// (не блокирует загрузку, только отчёт: modelFiles в ответе и оповещении).
const ALLOWED_EXTENSIONS = ['.stl', '.3mf', '.step', '.obj', '.txt', '.zip'];
const FORBIDDEN_EXTENSIONS = [
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.sh', '.jar', '.dll',
];

// Максимальный размер zip-архива при загрузке (МБ) — MODELS_MAX_UPLOAD_MB (1 ГБ)
const MAX_UPLOAD_MB = parseInt(process.env.MODELS_MAX_UPLOAD_MB, 10) || 1024;
// TTL одноразового токена скачивания (минуты) — MODELS_TOKEN_TTL_MIN
const TOKEN_TTL_MIN = parseInt(process.env.MODELS_TOKEN_TTL_MIN, 10) || 15;
const TOKEN_TTL_MS = TOKEN_TTL_MIN * 60 * 1000;

// Допустимые символы артикула: буквы/цифры/точка/дефис/подчёркивание.
// Защита от path traversal в ключе S3 и в имени файла.
const OFFER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Нормализует артикул: обрезает пробелы и завершающий '.zip',
 * если админ вставил имя файла вместо артикула.
 * @returns {string|null} null — артикул некорректен
 */
function normalizeOfferId(rawOfferId) {
  if (typeof rawOfferId !== 'string') return null;
  let offerId = rawOfferId.trim();
  if (offerId.toLowerCase().endsWith('.zip')) {
    offerId = offerId.slice(0, -4);
  }
  if (!offerId || !OFFER_ID_RE.test(offerId)) return null;
  return offerId;
}

/**
 * Родительский offer_id без суффикса -NR / -NL (паритет с бот-версией):
 * 'ARD000003-NR' -> 'ARD000003-N'; без суффикса — null.
 */
function getParentOfferId(offerId) {
  if (typeof offerId === 'string' && (offerId.endsWith('-NR') || offerId.endsWith('-NL'))) {
    return offerId.slice(0, -1);
  }
  return null;
}

/**
 * Кандидаты поиска модели для артикула: сам артикул, затем родитель.
 */
function offerCandidates(offerId) {
  const list = [offerId];
  const parent = getParentOfferId(offerId);
  if (parent && !list.includes(parent)) list.push(parent);
  return list;
}

/**
 * Разбор central directory zip-архива (без внешних зависимостей).
 * Достаточно для валидации содержимого: имена файлов, размеры, флаг шифрования.
 * ZIP64 не поддерживается (наши архивы << 4 ГБ и < 65535 записей).
 * @param {Buffer} buffer
 * @returns {{name: string, flags: number, uncompressedSize: number}[]}
 */
function parseZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50; // 'PK\x05\x06'
  const CDH_SIG = 0x02014b50;  // 'PK\x01\x02'

  // Ищем EOCD с конца (максимальный комментарий — 65535 байт + 22 байта записи)
  const scanStart = Math.max(0, buffer.length - (65535 + 22));
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Повреждённый zip-архив: не найдена оглавляющая запись (EOCD)');
  }

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0) return [];
  if (cdOffset === 0xffffffff || totalEntries === 0xffff) {
    throw new Error('ZIP64-архивы не поддерживаются');
  }

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CDH_SIG) {
      throw new Error('Повреждённый zip-архив: ошибка в оглавлении');
    }
    const flags = buffer.readUInt16LE(pos + 8);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const name = buffer.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    entries.push({ name, flags, uncompressedSize });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Разбор и валидация содержимого zip-архива с моделями:
 *   • это zip (magic 'PK…') — ЖЁСТКО;
 *   • нет зашифрованных записей — ЖЁСТКО;
 *   • нет path traversal ('..', абсолютных путей) в именах — ЖЁСТКО;
 *   • нет запрещённых расширений (исполняемые файлы) — ЖЁСТКО;
 *   • суммарный распакованный размер в пределах лимита (2x от MAX_UPLOAD_MB) — ЖЁСТКО;
 *   • расширения ФАЙЛОВ-МОДЕЛЕЙ внутри архива — МЯГКО: архив с посторонними
 *     файлами (.docx и т.п.) загружается, но список модельных файлов попадает
 *     в ответ админу и в оповещение персонала (modelFiles / hasModelFiles).
 * @param {Buffer} buffer
 * @returns {{ entries: string[], modelFiles: string[], hasModelFiles: boolean, totalUncompressed: number }}
 */
function validateZipBuffer(buffer) {
  if (!buffer || !buffer.length) {
    throw new Error('Файл пустой');
  }
  const magic = buffer.slice(0, 4).toString('latin1');
  if (!magic.startsWith('PK')) {
    throw new Error('Файл не является zip-архивом');
  }

  const entries = parseZipEntries(buffer);
  if (!entries.length) {
    throw new Error('zip-архив пустой');
  }

  const maxUncompressedBytes = MAX_UPLOAD_MB * 2 * 1024 * 1024;
  const names = [];
  const modelFiles = [];
  let totalUncompressed = 0;

  for (const entry of entries) {
    const name = entry.name;
    if (name.includes('..') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
      throw new Error(`Недопустимый путь в архиве: ${name}`);
    }
    if (entry.flags & 0x1) {
      throw new Error(`Запись зашифрована — заливка запрещена: ${name}`);
    }
    if (name.endsWith('/')) continue; // каталог — не файл
    const lower = name.toLowerCase();
    if (FORBIDDEN_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      throw new Error(`Запрещённый тип файла в архиве: ${name}`);
    }
    // Мягкая часть: просто фиксируем, что это файл модели
    if (ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      modelFiles.push(name);
    }
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) {
      throw new Error(
        `Распакованное содержимое превышает лимит ${MAX_UPLOAD_MB * 2} МБ`
      );
    }
    names.push(name);
  }

  return {
    entries: names,
    modelFiles,
    hasModelFiles: modelFiles.length > 0,
    totalUncompressed,
  };
}

/**
 * ЖЁСТКАЯ валидация загружаемого персоналом файла модели (перед заливкой в S3):
 *   1) имя файла обязательно оканчивается на '.zip' (модель — ВСЕГДА один zip
 *      на артикул, например ARD000003-N.zip);
 *   2) содержимое обязано быть zip-архивом (magic-байты + разбор оглавления).
 * Любая ошибка здесь отклоняет загрузку: контроллер превращает её в 400 +
 * live-оповещение загрузившему (в истории оповещений запись не создаётся).
 * @param {string|null} fileName - оригинальное имя загруженного файла
 * @param {Buffer} buffer
 * @returns {{ entries: string[], modelFiles: string[], hasModelFiles: boolean, totalUncompressed: number }}
 */
function validateUploadFile(fileName, buffer) {
  if (fileName) {
    const baseName = String(fileName).trim().split(/[\\/]/).pop();
    if (baseName && !baseName.toLowerCase().endsWith('.zip')) {
      const err = new Error(
        `Допускается только zip-архив: получен «${baseName}». ` +
        `Модель на артикул — один архив, назовите файл «{offer_id}.zip» (например, ARD000003-N.zip)`
      );
      err.validation = true;
      throw err;
    }
  }
  try {
    return validateZipBuffer(buffer);
  } catch (err) {
    err.validation = true;
    throw err;
  }
}

class ModelService {
  // =====================================================================
  // ПОИСК МОДЕЛЕЙ
  // =====================================================================

  /**
   * Найти модель для offer_id с учётом родительского артикула (-NR/-NL -> -N).
   * @returns {{ model: object, matchedOfferId: string }|null}
   */
  static async resolveModel(offerId) {
    for (const candidate of offerCandidates(offerId)) {
      const model = await OfferModel.get(candidate);
      if (model) return { model, matchedOfferId: candidate };
    }
    return null;
  }

  /**
   * Пакетный поиск моделей для списка offer_id (один запрос в БД).
   * @returns {Promise<Map<string, {model: object, matchedOfferId: string}>>}
   */
  static async resolveForOffers(offerIds) {
    const result = new Map();
    const unique = Array.from(new Set((offerIds || []).filter(Boolean).map(String)));
    if (!unique.length) return result;

    // Собираем всех кандидатов (артикул + родитель) одним запросом
    const allCandidates = new Set();
    const candidateLists = new Map();
    for (const offerId of unique) {
      const candidates = offerCandidates(offerId);
      candidateLists.set(offerId, candidates);
      candidates.forEach((c) => allCandidates.add(c));
    }
    const rows = await OfferModel.getBatch(Array.from(allCandidates));

    for (const [offerId, candidates] of candidateLists) {
      for (const candidate of candidates) {
        const model = rows.get(candidate);
        if (model) {
          result.set(offerId, { model, matchedOfferId: candidate });
          break;
        }
      }
    }
    return result;
  }

  // =====================================================================
  // ЗАГРУЗКА / УДАЛЕНИЕ / СПИСОК (админ)
  // =====================================================================

  /**
   * Залить новый zip для offer_id: валидация -> S3 -> БД -> инвалидация кэша
   * -> оповещения (сотрудникам с выданной моделью + журнал персонала).
   * Модель на артикул — ВСЕГДА один zip: при обновлении файлов заливается
   * новый архив целиком и перезаписывает старый (s3://bucket/{offer_id}.zip).
   * @param {string} rawOfferId
   * @param {Buffer} buffer
   * @param {number} userId - кто загрузил (admin/moderator/god)
   * @param {string|null} uploadedFileName - оригинальное имя файла (жёсткая проверка .zip)
   * @param {string|null} uploaderName - имя загрузившего (для журнала персонала)
   */
  static async uploadModel(rawOfferId, buffer, userId, uploadedFileName = null, uploaderName = null) {
    const offerId = normalizeOfferId(rawOfferId);
    if (!offerId) {
      const err = new Error(
        `Некорректный артикул "${rawOfferId}" — допустимы буквы, цифры, точка, дефис, подчёркивание`
      );
      err.validation = true;
      throw err;
    }

    // ЖЁСТКАЯ валидация: имя файла обязано быть .zip + содержимое обязано быть
    // zip-архивом. Внутри архива расширения файлов-моделей проверяются МЯГКО.
    const validation = validateUploadFile(uploadedFileName, buffer);

    // Хеш для инвалидации кэша и контроля версий
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // S3: s3://bucket/{offer_id}.zip (в корне бакета, перезапись) + сброс кэша
    await StorageService.uploadZip(offerId, buffer);
    const s3Key = StorageService.keyFor(offerId);
    const fileName = StorageService.fileNameFor(offerId);

    // Метаданные в БД
    const record = await OfferModel.set(offerId, {
      s3Key,
      fileName,
      fileHash,
      fileSize: buffer.length,
      uploadedBy: userId,
    });

    // Журнал персонала: модель загружена/обновлена (+ список файлов-моделей)
    NotificationService.notifyStaff('model_uploaded', {
      offerId,
      fileName,
      fileSize: buffer.length,
      filesCount: validation.entries.length,
      modelFiles: validation.modelFiles,
      hasModelFiles: validation.hasModelFiles,
      adminName: uploaderName,
      adminId: userId,
    });

    // Сотрудники, у которых этот offer_id уже выдан: модель обновилась —
    // предложить скачать заново (кэш уже сброшен).
    const issuedUsers = await OfferModel.getUsersWithIssued(offerId);
    for (const u of issuedUsers) {
      if (u.is_fired) continue;
      NotificationService.notifyUser(u.user_id, 'model_updated', {
        offerId,
        fileName,
        fileSize: buffer.length,
      });
    }

    console.log(
      `[MODELS] Модель ${offerId} загружена (${fileName}, ${buffer.length} байт, файлов в zip: ${validation.entries.length}, модельных: ${validation.modelFiles.length}, sha256: ${fileHash.slice(0, 12)}…)`
    );
    return {
      ...record,
      entries: validation.entries,
      modelFiles: validation.modelFiles,
      hasModelFiles: validation.hasModelFiles,
      totalUncompressed: validation.totalUncompressed,
    };
  }

  /**
   * Удалить модель: zip из S3 + метаданные + журнал персонала.
   * @param {string} offerId
   * @param {number|null} adminId - кто удалил
   * @param {string|null} adminName - имя удалившего (для журнала персонала)
   */
  static async deleteModel(offerId, adminId = null, adminName = null) {
    await StorageService.deleteZip(offerId);
    await OfferModel.delete(offerId);
    NotificationService.notifyStaff('model_deleted', {
      offerId,
      adminName,
      adminId,
    });
    console.log(`[MODELS] Модель ${offerId} удалена (S3 + БД)`);
  }

  /**
   * Список всех моделей с именами загрузивших.
   */
  static async listModels() {
    return OfferModel.getAll();
  }

  // =====================================================================
  // ВЫДАЧА ПРИ НАЗНАЧЕНИИ ЗАКАЗА (вызывается из OrderService.assignOrder)
  // =====================================================================

  /**
   * Оповещение ПЕРСОНАЛА: модель найдена НЕ по прямому артикулу, а по
   * родительскому (getParentOfferId: -NR/-NL -> -N). В журнал действий
   * пишется запись с ОБОИМИ артикулами — персонал видит, что для прямого
   * offer_id модели нет, и при необходимости заливает её отдельно.
   * Никогда не бросает исключений.
   * @param {object} ctx - { context: 'assign'|'download'|'request', orderId, userId, userName }
   * @param {Array<{offerId: string, parentOfferId: string, fileName?: string}>} parentOffers
   */
  static async notifyParentUsage(ctx, parentOffers) {
    if (!Array.isArray(parentOffers) || !parentOffers.length) return;
    try {
      await NotificationService.notifyStaff('models_parent_used', {
        context: (ctx && ctx.context) || null,
        orderId: (ctx && ctx.orderId) || null,
        userId: (ctx && ctx.userId) || null,
        userName: (ctx && ctx.userName) || null,
        parentOffers,
      });
      console.log(
        `[MODELS] Модель выдана по родительскому артикулу (${(ctx && ctx.context) || 'unknown'}): ` +
        parentOffers.map((x) => `${x.offerId} <- ${x.parentOfferId}`).join(', ')
      );
    } catch (err) {
      console.error('[MODELS] Ошибка оповещения о родительском артикуле:', err.message);
    }
  }

  /**
   * Выдать модели сотруднику по составу заказа (шаг 9 из бот-версии):
   *   • для каждого offer_id из orderDetails.products ищем модель
   *     (с учётом родительского артикула);
   *   • найденные — записываем в issued_models (идемпотентно);
   *   • оповещаем сотрудника «модели доступны» и персонал (выдано / отсутствуют);
   *   • ВАЖНО: если модель найдена не по прямому артикулу, а через родительский
   *     offer_id (-NR/-NL -> -N), персоналу уходит отдельное оповещение
   *     `models_parent_used` с ОБОИМИ артикулами для идентификации.
   * Ошибки не прерывают назначение заказа — логируем и журналируем.
   * @returns {Promise<{available: Array, missing: Array, parentMatched: Array}>}
   */
  static async issueForAssignment(orderId, userId, employee, orderDetails) {
    const products = (orderDetails && orderDetails.products) || [];
    const available = [];
    const missing = [];
    const parentMatched = [];

    // Пакетный поиск моделей по всем артикулам заказа
    const offerIds = products.map((p) => p.offer_id).filter(Boolean);
    const resolvedMap = await this.resolveForOffers(offerIds);

    for (const product of products) {
      const offerId = product.offer_id;
      if (!offerId) continue;
      const resolved = resolvedMap.get(offerId);
      if (!resolved) {
        missing.push({ offerId, productName: product.name || null });
        continue;
      }
      const fileName =
        resolved.model.file_name || StorageService.fileNameFor(resolved.matchedOfferId);

      // Модель найдена у родителя, а не по прямому артикулу — фиксируем
      // для отдельного оповещения персонала (артикул товара + артикул модели).
      if (String(resolved.matchedOfferId) !== String(offerId)) {
        parentMatched.push({
          offerId: String(offerId),
          productName: product.name || null,
          parentOfferId: String(resolved.matchedOfferId),
          fileName,
        });
      }
      // Учёт выдачи по ИСХОДНОМУ offer_id товара (как в боте), даже если
      // модель найдена у родителя: доступ проверяется по паре (user, offer).
      await OfferModel.addIssued(userId, offerId);
      available.push({
        offerId,
        sourceOfferId: resolved.matchedOfferId,
        fileName,
        fileSize: resolved.model.file_size || null,
      });
    }

    // Артикулы/файлы для текстов оповещений (идентификация «везде»)
    const parentOffersPayload = parentMatched.map((p) => ({
      offerId: p.offerId,
      parentOfferId: p.parentOfferId,
      fileName: p.fileName,
    }));

    if (available.length) {
      await NotificationService.notifyUser(userId, 'models_available', {
        orderId,
        userName: employee?.name || null,
        offerIds: available.map((a) => a.offerId),
        sourceOfferIds: available.map((a) => a.sourceOfferId),
        parentOffers: parentOffersPayload,
        missingOffers: missing.map((m) => m.offerId),
      });
      // Журнал персонала: тот же шаблон (staff-текст) — «выданы 3D-модели»
      await NotificationService.notifyStaff('models_available', {
        orderId,
        userName: employee?.name || null,
        offerIds: available.map((a) => a.offerId),
        sourceOfferIds: available.map((a) => a.sourceOfferId),
        parentOffers: parentOffersPayload,
        missingOffers: missing.map((m) => m.offerId),
      });
    }

    // === Модель выдана по РОДИТЕЛЬСКОМУ артикулу (прямого артикула нет) ===
    // Персонал должен знать: для offer_id товара модели не нашлось, поэтому
    // выдана модель родителя. Оповещение — только персоналу (журнал + live
    // модераторам), с обоими артикулами для идентификации.
    await this.notifyParentUsage(
      { context: 'assign', orderId, userId, userName: employee?.name || null },
      parentMatched
    );

    if (missing.length) {
      // Персоналу (модераторам) — о моделях, которые нужно залить/выдать вручную;
      // сотруднику — только если не нашлось НИ ОДНОЙ модели (иначе текст в
      // models_available уже упоминает недостающие артикулы).
      await NotificationService.notifyStaff('models_missing', {
        orderId,
        userName: employee?.name || null,
        offerIds: missing.map((m) => m.offerId),
      });
      if (!available.length) {
        await NotificationService.notifyUser(userId, 'models_missing', {
          orderId,
          userName: employee?.name || null,
          offerIds: missing.map((m) => m.offerId),
        });
      }
    }

    console.log(
      `[MODELS] Выдача по заказу ${orderId}: доступно ${available.length}, отсутствует ${missing.length}, по родителю ${parentMatched.length}`
    );
    return { available, missing, parentMatched };
  }

  // =====================================================================
  // ВЫДАЧА ТОКЕНА И СКАЧИВАНИЕ (без прямых ссылок на S3)
  // =====================================================================

  /**
   * Проверка доступа пользователя к модели offer_id:
   *   1) роль персонала (admin/moderator/god) — может скачать любую;
   *   2) offer_id (или родитель) выдан сотруднику (issued_models);
   *   3) fallback: offer_id есть в составе АКТИВНОГО заказа сотрудника
   *      (покрывает случай, когда модель залили уже после назначения).
   * @returns {Promise<{allowed: boolean, matchedOfferId: string|null, source: string|null}>}
   *   matchedOfferId — по какому артикулу доступ реально найден (для случая,
   *   когда модель выдана родительским артикулом — нужно оповестить персонал).
   */
  static async checkAccess(offerId, user) {
    if (!user) return { allowed: false, matchedOfferId: null, source: null };
    if (STAFF_ROLES.includes(user.role)) {
      return { allowed: true, matchedOfferId: offerId, source: 'staff' };
    }

    const candidates = offerCandidates(offerId);
    const issuedMatch = await OfferModel.matchIssued(user.id, candidates);
    if (issuedMatch) {
      return { allowed: true, matchedOfferId: issuedMatch, source: 'issued' };
    }

    // Fallback: артикул в составе активного заказа сотрудника
    try {
      const db = getDB();
      const activeOrders = await db.all(
        `SELECT order_id FROM assignments WHERE user_id = ? AND status = 'assigned'`,
        user.id
      );
      for (const order of activeOrders) {
        const details = await OzonService.getOrderDetails(order.order_id);
        const products = (details && details.products) || [];
        for (const candidate of candidates) {
          if (products.some((p) => String(p.offer_id) === candidate)) {
            return { allowed: true, matchedOfferId: candidate, source: 'active_order' };
          }
        }
      }
    } catch (err) {
      console.error('[MODELS] Ошибка fallback-проверки доступа:', err.message);
    }
    return { allowed: false, matchedOfferId: null, source: null };
  }

  /**
   * Выдать одноразовый токен скачивания модели.
   *
   * Если модель найдена НЕ по прямому артикулу, а по родительскому
   * (getParentOfferId: -NR/-NL -> -N), персоналу отправляется оповещение
   * `models_parent_used` с обоими артикулами — так персонал узнаёт, что для
   * этого offer_id отдельной модели нет (и при необходимости зальёт её).
   * @returns {Promise<{token: string, expiresAt: number, offerId: string, sourceOfferId: string, requestedOfferId: string, fileName: string, fileSize: number|null}>}
   */
  static async requestToken(rawOfferId, user) {
    const offerId = normalizeOfferId(rawOfferId);
    if (!offerId) {
      throw new Error('Некорректный артикул');
    }

    const resolved = await this.resolveModel(offerId);
    if (!resolved) {
      throw new Error(`Модель для артикула ${offerId} не найдена`);
    }

    const access = await this.checkAccess(offerId, user);
    if (!access.allowed) {
      const err = new Error('Модель не выдана вам — запросите у модератора');
      err.status = 403;
      throw err;
    }

    const fileName =
      resolved.model.file_name || StorageService.fileNameFor(resolved.matchedOfferId);

    // Модель взята у родительского артикула — персонал должен это знать.
    // Оповещаем только для сотрудников (персонал скачивает и по прямым ссылкам,
    // ему такие оповещения не нужны).
    const isStaff = ['admin', 'moderator', 'god'].includes(user.role);
    if (!isStaff && String(resolved.matchedOfferId) !== String(offerId)) {
      await this.notifyParentUsage(
        { context: 'download', orderId: null, userId: user.id, userName: user.name || null },
        [{
          offerId: String(offerId),
          productName: null,
          parentOfferId: String(resolved.matchedOfferId),
          fileName,
        }]
      );
    }

    const { token, expiresAt } = await OfferModel.createToken(
      resolved.matchedOfferId,
      user.id,
      TOKEN_TTL_MS
    );

    return {
      token,
      expiresAt,
      offerId: resolved.matchedOfferId,
      sourceOfferId: resolved.matchedOfferId,
      requestedOfferId: String(offerId),
      fileName,
      fileSize: resolved.model.file_size || null,
    };
  }

  /**
   * Погасить одноразовый токен и вернуть данные для отдачи файла.
   * Токен помечается использованным ДО скачивания (повторное обращение — отказ).
   * @returns {Promise<{offerId: string, userId: number}>}
   */
  static async consumeToken(token) {
    const row = await OfferModel.getLiveToken(token);
    if (!row) {
      const err = new Error('Токен недействителен, истёк или уже использован');
      err.status = 403;
      throw err;
    }
    await OfferModel.markTokenUsed(token);
    return { offerId: row.offer_id, userId: row.user_id };
  }

  /**
   * Подготовить файл модели к отдаче: путь в кэше (с прогревом из S3) + размер.
   */
  static async getDownloadInfo(offerId) {
    const info = await StorageService.getZipInfo(offerId);
    return { ...info, fileName: StorageService.fileNameFor(offerId) };
  }

  // =====================================================================
  // ОБОГАЩЕНИЕ СПИСКОВ ЗАКАЗОВ ИНФОРМАЦИЕЙ О МОДЕЛЯХ
  // =====================================================================

  /**
   * Прикрепить к каждому товару информацию о доступной модели (p.model).
   * Используется в getActiveOrders (сотрудник) и getActiveOrdersAll (админ):
   * по флагу клиент рисует кнопку «Скачать модель».
   */
  static async attachToProducts(products) {
    if (!Array.isArray(products) || !products.length) return products || [];
    const offerIds = products.map((p) => p.offer_id).filter(Boolean);
    const resolvedMap = await this.resolveForOffers(offerIds);
    for (const p of products) {
      if (!p.offer_id) continue;
      const resolved = resolvedMap.get(p.offer_id);
      if (!resolved) {
        p.model = null;
        continue;
      }
      // matchedOfferId может быть родительским артикулом товара (-NR/-NL -> -N):
      // sourceOfferId != offer_id — клиент показывает, что выдан архив родителя.
      const sourceOfferId = String(resolved.matchedOfferId);
      p.model = {
        offerId: sourceOfferId,
        sourceOfferId,
        requestedOfferId: String(p.offer_id),
        isParent: sourceOfferId !== String(p.offer_id),
        fileName: resolved.model.file_name || StorageService.fileNameFor(sourceOfferId),
        fileSize: resolved.model.file_size || null,
      };
    }
    return products;
  }
}

// Утилиты доступны и как статические методы класса — единая точка входа:
// require('./ModelService') возвращает сам класс ModelService.
ModelService.normalizeOfferId = normalizeOfferId;
ModelService.getParentOfferId = getParentOfferId;
ModelService.offerCandidates = offerCandidates;
ModelService.validateZipBuffer = validateZipBuffer;
ModelService.validateUploadFile = validateUploadFile;
ModelService.parseZipEntries = parseZipEntries;
ModelService.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;
ModelService.FORBIDDEN_EXTENSIONS = FORBIDDEN_EXTENSIONS;
ModelService.MAX_UPLOAD_MB = MAX_UPLOAD_MB;
ModelService.TOKEN_TTL_MIN = TOKEN_TTL_MIN;
ModelService.TOKEN_TTL_MS = TOKEN_TTL_MS;

module.exports = ModelService;

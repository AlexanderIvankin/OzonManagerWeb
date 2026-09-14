const crypto = require('crypto');
const OfferModel = require('../models/OfferModel');
const StorageService = require('./StorageService');
const NotificationService = require('./NotificationService');
const OzonService = require('./OzonService');
const { getDB } = require('../config/database');

// ============================================================================
// ModelService — единая точка работы с 3D-моделями: обёртка над StorageService
// (S3 + локальный кэш) и БД (offer_models / issued_models / tokens).
//
// Принцип работы (zip-first):
//   • модель на артикул — ОДИН zip-архив в S3: s3://bucket/models/{offer_id}.zip;
//     при любом обновлении файлов перезаливается целиком новый zip;
//   • прямых ссылок на S3 нет: клиент запрашивает одноразовый токен
//     (POST /api/models/request/:offerId), затем скачивает файл по токену
//     (GET /api/models/download/:token); бэкенд отдаёт файл из локального кэша,
//     прогревая его из S3 при необходимости;
//   • при назначении заказа (OrderService.assignOrder) модели по составу заказа
//     записываются сотруднику в issued_models и приходит оповещение
//     «модели доступны»;
//   • выдача учитывает родительский артикул: для ARD000003-NR/-NL ищется
//     модель родителя ARD000003-N (как в бот-версии, getParentOfferId).
// ============================================================================
const ALLOWED_EXTENSIONS = ['.stl', '.3mf', '.step', '.obj', '.zip'];
const FORBIDDEN_EXTENSIONS = [
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.sh', '.jar', '.dll',
];

// Максимальный размер zip-архива при загрузке (МБ) — MODELS_MAX_UPLOAD_MB
const MAX_UPLOAD_MB = parseInt(process.env.MODELS_MAX_UPLOAD_MB, 10) || 200;
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
 * Валидация zip с моделями:
 *   • это zip (magic 'PK…');
 *   • нет зашифрованных записей;
 *   • нет path traversal ('..', абсолютных путей) в именах;
 *   • нет запрещённых расширений (исполняемые файлы);
 *   • есть хотя бы один файл с допустимым расширением модели;
 *   • суммарный распакованный размер в пределах лимита (2x от MAX_UPLOAD_MB).
 * @param {Buffer} buffer
 * @returns {{ entries: string[], totalUncompressed: number }}
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
  let hasAllowed = false;
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
    if (ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      hasAllowed = true;
    }
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) {
      throw new Error(
        `Распакованное содержимое превышает лимит ${MAX_UPLOAD_MB * 2} МБ`
      );
    }
    names.push(name);
  }

  if (!hasAllowed) {
    throw new Error(
      `В архиве нет 3D-моделей (допустимые расширения: ${ALLOWED_EXTENSIONS.join(', ')})`
    );
  }

  return { entries: names, totalUncompressed };
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
   * @param {string} rawOfferId
   * @param {Buffer} buffer
   * @param {number} userId - кто загрузил (admin/moderator/god)
   */
  static async uploadModel(rawOfferId, buffer, userId) {
    const offerId = normalizeOfferId(rawOfferId);
    if (!offerId) {
      throw new Error(
        `Некорректный артикул "${rawOfferId}" — допустимы буквы, цифры, точка, дефис, подчёркивание`
      );
    }

    // Валидация содержимого zip (расширения, traversal, шифрование, размер)
    const validation = validateZipBuffer(buffer);

    // Хеш для инвалидации кэша и контроля версий
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // S3: s3://bucket/models/{offer_id}.zip (перезапись) + сброс локального кэша
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

    // Журнал персонала: модель загружена/обновлена
    NotificationService.notifyStaff('model_uploaded', {
      offerId,
      fileName,
      fileSize: buffer.length,
      filesCount: validation.entries.length,
      adminName: null, // контроллер подставит имя
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
      `[MODELS] Модель ${offerId} загружена (${fileName}, ${buffer.length} байт, файлов в zip: ${validation.entries.length}, sha256: ${fileHash.slice(0, 12)}…)`
    );
    return { ...record, entries: validation.entries, totalUncompressed: validation.totalUncompressed };
  }

  /**
   * Удалить модель: zip из S3 + метаданные + журнал персонала.
   */
  static async deleteModel(offerId, adminId = null) {
    await StorageService.deleteZip(offerId);
    await OfferModel.delete(offerId);
    NotificationService.notifyStaff('model_deleted', {
      offerId,
      adminName: null,
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
   * Выдать модели сотруднику по составу заказа (шаг 9 из бот-версии):
   *   • для каждого offer_id из orderDetails.products ищем модель
   *     (с учётом родительского артикула);
   *   • найденные — записываем в issued_models (идемпотентно);
   *   • оповещаем сотрудника «модели доступны» и персонал (выдано / отсутствуют).
   * Ошибки не прерывают назначение заказа — логируем и журналируем.
   * @returns {Promise<{available: Array, missing: Array}>}
   */
  static async issueForAssignment(orderId, userId, employee, orderDetails) {
    const products = (orderDetails && orderDetails.products) || [];
    const available = [];
    const missing = [];

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
      // Учёт выдачи по ИСХОДНОМУ offer_id товара (как в боте), даже если
      // модель найдена у родителя: доступ проверяется по паре (user, offer).
      await OfferModel.addIssued(userId, offerId);
      available.push({
        offerId,
        sourceOfferId: resolved.matchedOfferId,
        fileName: resolved.model.file_name || StorageService.fileNameFor(resolved.matchedOfferId),
        fileSize: resolved.model.file_size || null,
      });
    }

    if (available.length) {
      NotificationService.notifyUser(userId, 'models_available', {
        orderId,
        userName: employee?.name || null,
        offerIds: available.map((a) => a.offerId),
        missingOffers: missing.map((m) => m.offerId),
      });
      // Журнал персонала: тот же шаблон (staff-текст) — «выданы 3D-модели»
      NotificationService.notifyStaff('models_available', {
        orderId,
        userName: employee?.name || null,
        offerIds: available.map((a) => a.offerId),
        missingOffers: missing.map((m) => m.offerId),
      });
    }

    if (missing.length) {
      // Персоналу (модераторам) — о моделях, которые нужно залить/выдать вручную;
      // сотруднику — только если не нашлось НИ ОДНОЙ модели (иначе текст в
      // models_available уже упоминает недостающие артикулы).
      NotificationService.notifyStaff('models_missing', {
        orderId,
        userName: employee?.name || null,
        offerIds: missing.map((m) => m.offerId),
      });
      if (!available.length) {
        NotificationService.notifyUser(userId, 'models_missing', {
          orderId,
          userName: employee?.name || null,
          offerIds: missing.map((m) => m.offerId),
        });
      }
    }

    console.log(
      `[MODELS] Выдача по заказу ${orderId}: доступно ${available.length}, отсутствует ${missing.length}`
    );
    return { available, missing };
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
   * @returns {Promise<boolean>}
   */
  static async checkAccess(offerId, user) {
    if (!user) return false;
    const STAFF_ROLES = ['admin', 'moderator', 'god'];
    if (STAFF_ROLES.includes(user.role)) return true;

    const candidates = offerCandidates(offerId);
    if (await OfferModel.hasIssuedAny(user.id, candidates)) return true;

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
        if (products.some((p) => candidates.includes(String(p.offer_id)))) {
          return true;
        }
      }
    } catch (err) {
      console.error('[MODELS] Ошибка fallback-проверки доступа:', err.message);
    }
    return false;
  }

  /**
   * Выдать одноразовый токен скачивания модели.
   * @returns {Promise<{token: string, expiresAt: number, offerId: string, fileName: string, fileSize: number|null}>}
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

    const hasAccess = await this.checkAccess(offerId, user);
    if (!hasAccess) {
      const err = new Error('Модель не выдана вам — запросите у модератора');
      err.status = 403;
      throw err;
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
      fileName: resolved.model.file_name || StorageService.fileNameFor(resolved.matchedOfferId),
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
      p.model = resolved
        ? {
            offerId: resolved.matchedOfferId,
            fileName: resolved.model.file_name || StorageService.fileNameFor(resolved.matchedOfferId),
            fileSize: resolved.model.file_size || null,
          }
        : null;
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
ModelService.parseZipEntries = parseZipEntries;
ModelService.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;
ModelService.FORBIDDEN_EXTENSIONS = FORBIDDEN_EXTENSIONS;
ModelService.MAX_UPLOAD_MB = MAX_UPLOAD_MB;
ModelService.TOKEN_TTL_MIN = TOKEN_TTL_MIN;
ModelService.TOKEN_TTL_MS = TOKEN_TTL_MS;

module.exports = ModelService;

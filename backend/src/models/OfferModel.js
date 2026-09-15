const { getDB } = require('../config/database');
const crypto = require('crypto');

/**
 * Управление 3D-моделями (zip-архивы в S3): метаданные (offer_models),
 * факты выдачи сотрудникам (issued_models) и одноразовые токены скачивания
 * (model_download_tokens). Одна запись = один offer_id: модель на артикул
 * всегда хранится одним zip-архивом в КОРНЕ бакета:
 * s3://<bucket>/{offer_id}.zip (например, ARD000003-N.zip).
 */
class OfferModel {
  // ============================ offer_models ============================

  /**
   * Получить запись модели по offer_id
   */
  static async get(offerId) {
    const db = getDB();
    return db.get('SELECT * FROM offer_models WHERE offer_id = ?', offerId);
  }

  /**
   * Создать/обновить модель по offer_id (перезапись zip в S3 выполняет StorageService).
   */
  static async set(offerId, { s3Key, fileName, fileHash, fileSize, uploadedBy }) {
    const db = getDB();
    await db.run(
      `INSERT INTO offer_models (offer_id, s3_key, file_name, file_hash, file_size, uploaded_at, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(offer_id) DO UPDATE SET
         s3_key = excluded.s3_key,
         file_name = excluded.file_name,
         file_hash = excluded.file_hash,
         file_size = excluded.file_size,
         uploaded_at = excluded.uploaded_at,
         uploaded_by = excluded.uploaded_by`,
      offerId, s3Key, fileName || `${offerId}.zip`, fileHash, fileSize, Date.now(), uploadedBy
    );
    return this.get(offerId);
  }

  /**
   * Удалить модель (метаданные; сам zip из S3 удаляет StorageService)
   */
  static async delete(offerId) {
    const db = getDB();
    await db.run('DELETE FROM offer_models WHERE offer_id = ?', offerId);
  }

  /**
   * Все модели (для страницы «Модели» в админке), с именем загрузившего
   */
  static async getAll() {
    const db = getDB();
    return db.all(`
      SELECT om.*, u.name AS uploaded_by_name
      FROM offer_models om
      LEFT JOIN users u ON om.uploaded_by = u.id
      ORDER BY om.offer_id
    `);
  }

  /**
   * Модели по списку offer_id (одним запросом)
   * @returns {Promise<Map<string, object>>} offer_id -> запись
   */
  static async getBatch(offerIds) {
    const result = new Map();
    if (!Array.isArray(offerIds) || !offerIds.length) return result;
    const db = getDB();
    const placeholders = offerIds.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT * FROM offer_models WHERE offer_id IN (${placeholders})`,
      ...offerIds
    );
    for (const row of rows) result.set(row.offer_id, row);
    return result;
  }

  /**
   * Сотрудники, у которых этот offer_id выдан (для оповещения об обновлении модели)
   */
  static async getUsersWithIssued(offerId) {
    const db = getDB();
    return db.all(
      `SELECT DISTINCT im.user_id, u.is_fired
       FROM issued_models im
       JOIN users u ON im.user_id = u.id
       WHERE im.offer_id = ?`,
      offerId
    );
  }

  // ============================ issued_models ============================

  /**
   * Записать факт выдачи модели сотруднику (идемпотентно).
   * @returns {Promise<boolean>} true — запись новая, false — уже выдавалась
   */
  static async addIssued(userId, offerId) {
    const db = getDB();
    const existing = await db.get(
      'SELECT id FROM issued_models WHERE user_id = ? AND offer_id = ?',
      userId, offerId
    );
    if (existing) return false;
    await db.run(
      'INSERT INTO issued_models (user_id, offer_id, issued_at) VALUES (?, ?, ?)',
      userId, offerId, Date.now()
    );
    return true;
  }

  /**
   * Все offer_id, выданные сотруднику (для индикатора 🟢🟡🔴 в админке)
   * @returns {Promise<string[]>}
   */
  static async getIssuedOfferIds(userId) {
    const db = getDB();
    const rows = await db.all(
      'SELECT offer_id FROM issued_models WHERE user_id = ?',
      userId
    );
    return rows.map((r) => r.offer_id);
  }

  /**
   * Проверить доступ сотрудника к модели: выдавался ли offer_id (или его родитель)
   */
  static async hasIssuedAny(userId, offerIds) {
    if (!Array.isArray(offerIds) || !offerIds.length) return false;
    const db = getDB();
    const placeholders = offerIds.map(() => '?').join(',');
    const row = await db.get(
      `SELECT 1 FROM issued_models WHERE user_id = ? AND offer_id IN (${placeholders}) LIMIT 1`,
      userId, ...offerIds
    );
    return !!row;
  }

  /**
   * Какой именно артикул из списка кандидатов выдан сотруднику.
   * Возвращает первый найденный в порядке переданного списка (сам артикул,
   * затем родительский) — нужен, чтобы понять, выдан ли доступ по прямому
   * артикулу или по родительскому (-NR/-NL -> -N) и оповестить персонал.
   * @returns {Promise<string|null>} выданный offer_id или null
   */
  static async matchIssued(userId, offerIds) {
    if (!Array.isArray(offerIds) || !offerIds.length) return null;
    const db = getDB();
    for (const offerId of offerIds) {
      const row = await db.get(
        'SELECT offer_id FROM issued_models WHERE user_id = ? AND offer_id = ? LIMIT 1',
        userId, offerId
      );
      if (row) return row.offer_id;
    }
    return null;
  }

  /**
   * Количество выданных артикулов с моделями (для статистики сотрудника)
   */
  static async getIssuedCount(userId) {
    const db = getDB();
    const row = await db.get(
      'SELECT COUNT(*) AS count FROM issued_models WHERE user_id = ?',
      userId
    );
    return row ? row.count : 0;
  }

  // ======================= model_download_tokens ========================

  /**
   * Создать одноразовый токен скачивания (32 случайных байта).
   * @param {string} offerId
   * @param {number} userId
   * @param {number} ttlMs - время жизни (по умолчанию 15 минут)
   * @returns {Promise<{token: string, expiresAt: number}>}
   */
  static async createToken(offerId, userId, ttlMs = 15 * 60 * 1000) {
    const db = getDB();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + ttlMs;
    await db.run(
      `INSERT INTO model_download_tokens (offer_id, user_id, token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      offerId, userId, token, expiresAt, Date.now()
    );
    return { token, expiresAt };
  }

  /**
   * Получить живой (не использованный и не просроченный) токен
   */
  static async getLiveToken(token) {
    const db = getDB();
    const row = await db.get('SELECT * FROM model_download_tokens WHERE token = ?', token);
    if (!row) return null;
    if (row.used_at) return null;                  // уже использован
    if (row.expires_at <= Date.now()) return null; // истёк
    return row;
  }

  /**
   * Пометить токен использованным (одноразовость)
   */
  static async markTokenUsed(token) {
    const db = getDB();
    await db.run(
      'UPDATE model_download_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL',
      Date.now(), token
    );
  }

  /**
   * Удалить просроченные/использованные токены (для планировщика).
   * @returns {Promise<number>} количество удалённых строк
   */
  static async pruneExpiredTokens() {
    const db = getDB();
    const res = await db.run(
      'DELETE FROM model_download_tokens WHERE expires_at < ? OR used_at IS NOT NULL',
      Date.now()
    );
    return res.changes || 0;
  }
}

module.exports = OfferModel;

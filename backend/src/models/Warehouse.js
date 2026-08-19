const { getDB } = require('../config/database');

/**
 * Управление складами и связями пользователь-склад
 */
class Warehouse {
  // -------------------- СКЛАДЫ --------------------

  /**
   * Синхронизировать список складов из Ozon (заменяет все)
   */
  static async syncAll(warehouses) {
    const db = getDB();
    await db.run('DELETE FROM warehouses');
    const now = Date.now();
    for (const wh of warehouses) {
      await db.run(
        `INSERT INTO warehouses (warehouse_id, name, address, is_rfbs, last_synced_at)
         VALUES (?, ?, ?, ?, ?)`,
        wh.warehouse_id, wh.name, wh.address || null, wh.is_rfbs ? 1 : 0, now
      );
    }
    console.log(`[Warehouse] Синхронизировано ${warehouses.length} складов`);
  }

  /**
   * Получить все склады
   */
  static async getAll() {
    const db = getDB();
    return db.all('SELECT warehouse_id, name, address, is_rfbs FROM warehouses ORDER BY name');
  }

  /**
   * Получить склад по ID
   */
  static async getById(warehouseId) {
    const db = getDB();
    return db.get('SELECT * FROM warehouses WHERE warehouse_id = ?', warehouseId);
  }

  /**
   * Получить название склада по ID (возвращает ID, если не найден)
   */
  static async getNameById(warehouseId) {
    const db = getDB();
    const result = await db.get('SELECT name FROM warehouses WHERE warehouse_id = ?', warehouseId);
    return result ? result.name : warehouseId;
  }

  // -------------------- СВЯЗЬ ПОЛЬЗОВАТЕЛЬ ↔ СКЛАД --------------------

  /**
   * Добавить связь пользователя со складом
   */
  static async addUserWarehouse(userId, warehouseId) {
    const db = getDB();
    await db.run(
      `INSERT OR IGNORE INTO user_warehouses (user_id, warehouse_id)
       VALUES (?, ?)`,
      userId, warehouseId
    );
  }

  /**
   * Удалить связь пользователя со складом
   */
  static async removeUserWarehouse(userId, warehouseId) {
    const db = getDB();
    await db.run(
      'DELETE FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?',
      userId, warehouseId
    );
  }

  /**
   * Получить склады, к которым привязан пользователь
   */
  static async getUserWarehouses(userId) {
    const db = getDB();
    return db.all(`
      SELECT w.warehouse_id, w.name, w.address, w.is_rfbs
      FROM user_warehouses uw
      JOIN warehouses w ON uw.warehouse_id = w.warehouse_id
      WHERE uw.user_id = ?
      ORDER BY w.name
    `, userId);
  }

  /**
   * Очистить все связи для пользователя (при перезаписи)
   */
  static async clearUserWarehouses(userId) {
    const db = getDB();
    await db.run('DELETE FROM user_warehouses WHERE user_id = ?', userId);
  }
}

module.exports = Warehouse;
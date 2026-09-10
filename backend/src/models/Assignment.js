const { getDB } = require('../config/database');

class Assignment {
  /**
   * Назначить заказ сотруднику (пользователю)
   */
  static async assign(orderId, userId) {
    const db = getDB();
    await db.run(
      `INSERT OR REPLACE INTO assignments (order_id, user_id, assigned_at, status)
       VALUES (?, ?, ?, ?)`,
      orderId, userId, Date.now(), 'assigned'
    );
  }

  /**
   * Завершить заказ (обновить статус на 'completed')
   */
  static async complete(orderId) {
    const db = getDB();
    await db.run(
      `UPDATE assignments SET status = 'completed', completed_at = ? WHERE order_id = ? AND status = 'assigned'`,
      Date.now(), orderId
    );
  }

  /**
   * Отменить заказ (удалить назначение) – для ручной отмены сотрудником
   */
  static async cancel(orderId, userId) {
    const db = getDB();
    // Проверяем, что заказ принадлежит этому пользователю и ещё не завершён
    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
      orderId, userId
    );
    if (!assignment) throw new Error('Order not found or already completed');
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
    // Увеличиваем счётчик отменённых (в UserStats)
    // Это сделаем позже через отдельный метод
  }

  /**
   * Автоматическая отмена (без увеличения счётчика отмен) – используется при очистке
   */
  static async autoCancel(orderId) {
    const db = getDB();
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
  }

  /**
   * Получить активные заказы пользователя
   */
  static async getActiveOrders(userId) {
    const db = getDB();
    return db.all(
      'SELECT order_id, assigned_at FROM assignments WHERE user_id = ? AND status = "assigned"',
      userId
    );
  }

  /**
   * Получить количество активных заказов пользователя
   */
  static async getActiveOrdersCount(userId) {
    const db = getDB();
    const row = await db.get(
      'SELECT COUNT(*) as count FROM assignments WHERE user_id = ? AND status = "assigned"',
      userId
    );
    return row ? row.count : 0;
  }

  /**
   * Проверить, назначен ли заказ конкретному пользователю
   */
  static async isAssignedToUser(orderId, userId) {
    const db = getDB();
    const row = await db.get(
      'SELECT 1 FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
      orderId, userId
    );
    return !!row;
  }

  /**
   * Получить все активные назначения (для админа)
   */
  static async getAllActive() {
    const db = getDB();
    return db.all(
      `SELECT a.order_id, a.user_id, u.name as user_name, a.assigned_at
       FROM assignments a
       JOIN users u ON a.user_id = u.id
       WHERE a.status = 'assigned'`
    );
  }

  /**
   * Получить назначение по order_id (для проверки)
   */
  static async getByOrderId(orderId) {
    const db = getDB();
    return db.get('SELECT * FROM assignments WHERE order_id = ?', orderId);
  }

  /**
   * Получить завершённые заказы пользователя (для отправки этикеток)
   */
  static async getCompletedOrders(userId) {
    const db = getDB();
    return db.all(
      'SELECT order_id, completed_at FROM assignments WHERE user_id = ? AND status = "completed"',
      userId
    );
  }

  /**
   * Последние завершённые заказы с фильтрами (для админки).
   * Возвращает заказы от новых к старым с суммой заработка из earnings_history
   * (LEFT JOIN — если заработок не сохранён, amount = null).
   *
   * @param {number|null} userId    — ID сотрудника (null = все сотрудники)
   * @param {object} [options]
   * @param {number|null} [options.days]  — период: сколько последних дней включать (null = всё время)
   * @param {number} [options.limit]      — максимум записей (по умолчанию 50)
   */
  static async getRecentCompletedOrders(userId, { days = null, limit = 50 } = {}) {
    const db = getDB();
    let sql = `
      SELECT a.order_id, a.completed_at, a.user_id, u.name AS user_name,
        (SELECT COALESCE(SUM(amount), 0)
         FROM earnings_history eh
         WHERE eh.order_id = a.order_id AND eh.user_id = a.user_id) AS amount
      FROM assignments a
      JOIN users u ON a.user_id = u.id
      WHERE a.status = 'completed'
    `;
    const params = [];
    if (userId) {
      sql += ' AND a.user_id = ?';
      params.push(userId);
    }
    if (days) {
      sql += ' AND a.completed_at >= ?';
      params.push(Date.now() - days * 24 * 60 * 60 * 1000);
    }
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    sql += ' ORDER BY a.completed_at DESC LIMIT ?';
    params.push(safeLimit);
    return db.all(sql, ...params);
  }
}

module.exports = Assignment;
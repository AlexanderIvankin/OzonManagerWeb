const { getDB } = require('../config/database');

class User {
  /**
   * Создаёт нового пользователя
   */
  static async create(data) {
    const db = getDB();
    const {
      username, email, passwordHash, name,
      phone = '', capacity = 1, earningsFactor = 1.0, role = 'user'
    } = data;

    // Проверяем уникальность username и email
    const existing = await db.get(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      username, email
    );
    if (existing) {
      const conflict = existing.username === username ? 'username' : 'email';
      throw new Error(`${conflict} already taken`);
    }

    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, name, phone, capacity, earnings_factor, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      username, email, passwordHash, name, phone, capacity, earningsFactor, role, Date.now(), Date.now()
    );
    const id = result.lastID;
    return this.getById(id);
  }

  static async getById(id) {
    const db = getDB();
    const user = await db.get(
      `SELECT id, username, email, name, phone, capacity, earnings_factor, role, is_fired, taking_orders, tg_user_id, created_at, updated_at
       FROM users WHERE id = ?`,
      id
    );
    return user || null;
  }

  static async getByUsername(username) {
    const db = getDB();
    const user = await db.get(
      `SELECT id, username, email, password_hash, name, phone, capacity, earnings_factor, role, is_fired, taking_orders, tg_user_id
       FROM users WHERE username = ?`,
      username
    );
    return user || null;
  }

  static async getByEmail(email) {
    const db = getDB();
    const user = await db.get(
      `SELECT id, username, email, password_hash, name, phone, capacity, earnings_factor, role, is_fired, taking_orders, tg_user_id
       FROM users WHERE email = ?`,
      email
    );
    return user || null;
  }

  static async findByTgId(tgUserId) {
    const db = getDB();
    return db.get('SELECT * FROM users WHERE tg_user_id = ?', tgUserId);
  }

  static async update(id, fields) {
    const db = getDB();
    const allowed = ['name', 'phone', 'capacity', 'earnings_factor', 'role', 'is_fired', 'taking_orders'];
    const setClauses = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      // Пропускаем undefined, чтобы частичные обновления не затирали остальные поля
      if (allowed.includes(key) && val !== undefined) {
        setClauses.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (setClauses.length === 0) return;
    values.push(Date.now()); // updated_at
    values.push(id);
    await db.run(
      `UPDATE users SET ${setClauses.join(', ')}, updated_at = ? WHERE id = ?`,
      values
    );
    return this.getById(id);
  }

  static async setPasswordHash(id, hash) {
    const db = getDB();
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, id);
  }

  static async setTelegramId(id, tgUserId) {
    const db = getDB();
    await db.run('UPDATE users SET tg_user_id = ? WHERE id = ?', tgUserId, id);
  }

  static async updateByTgId(tgUserId, updates) {
    const db = getDB();
    const user = await this.findUserByTgId(tgUserId);
    if (!user) return null;
    // Обновляем поля
    const allowed = ['name', 'phone', 'capacity', 'earnings_factor'];
    const setClauses = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) {
      // Пропускаем undefined, чтобы частичные обновления не затирали остальные поля
      if (allowed.includes(key) && val !== undefined) {
        setClauses.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (setClauses.length === 0) return user;
    values.push(Date.now());
    values.push(user.id);
    await db.run(
      `UPDATE users SET ${setClauses.join(', ')}, updated_at = ? WHERE id = ?`,
      values
    );
    return this.getById(user.id);
  }

  /**
 * Получить пользователя с расширенной информацией (активные заказы, статистика)
 */
  static async getWithDetails(id) {
    const db = getDB();
    const user = await this.getById(id);
    if (!user) return null;

    // Активные заказы
    const activeOrders = await db.all(
      'SELECT order_id, assigned_at FROM assignments WHERE user_id = ? AND status = "assigned"',
      id
    );
    // Статистика
    const stats = await db.get(
      'SELECT total_orders, total_amount, canceled_orders FROM user_stats WHERE user_id = ?',
      id
    );

    return {
      ...user,
      activeOrders: activeOrders || [],
      stats: stats || { total_orders: 0, total_amount: 0, canceled_orders: 0 },
    };
  }

  /**
   * Получить всех пользователей с фильтрацией (для админа)
   */
  static async getAll({ includeFired = false, includeAll = false, role = null } = {}) {
    const db = getDB();
    let sql = `SELECT id, username, email, name, phone, capacity, earnings_factor, role, is_fired, taking_orders, tg_user_id, created_at, updated_at FROM users`;
    const conditions = [];
    const params = [];

    if (!includeFired) {
      conditions.push('is_fired = 0');
    }
    if (!includeAll) {
      conditions.push('taking_orders = 1');
    }
    if (role) {
      conditions.push('role = ?');
      params.push(role);
    }

    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY id';

    return db.all(sql, params);
  }
}

module.exports = User;
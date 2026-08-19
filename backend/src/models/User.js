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

  static async update(id, fields) {
    const db = getDB();
    const allowed = ['name', 'phone', 'capacity', 'earnings_factor', 'role', 'is_fired', 'taking_orders'];
    const setClauses = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      if (allowed.includes(key)) {
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
}

module.exports = User;
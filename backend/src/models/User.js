const { getDB } = require('../config/database');

class User {
  /**
   * Создаёт нового пользователя
   */
  static async create(data) {
    const db = getDB();
    const {
      username, email, passwordHash, name,
      displayName = null,
      phone = '', capacity = 1, earningsFactor = 1.0, role = 'user',
      // Гость (неподтверждённый email) не состоит в команде: сразу
      // is_fired = 1, приём заказов выключен — он не попадает ни в один
      // список активных сотрудников (подтверждение восстанавливает флаги,
      // см. AuthService.verifyEmail).
      isFired = 0, takingOrders = 1,
      tgUserId = null
    } = data;

    // Проверяем уникальность username и email
    const existing = await db.get(
      'SELECT id, username, email FROM users WHERE username = ? OR email = ?',
      username, email
    );
    if (existing) {
      const conflict = existing.username === username ? 'username' : 'email';
      throw new Error(`${conflict} already taken`);
    }

    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, name, display_name, phone, capacity, earnings_factor, role, is_fired, taking_orders, tg_user_id, was_employee, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      username, email, passwordHash, name, displayName, phone, capacity, earningsFactor, role, isFired, takingOrders, tgUserId || null,
      // Staff-роль (employee/moderator/admin/god) — сразу был сотрудником
      ['employee', 'moderator', 'admin', 'god'].includes(role) ? 1 : 0,
      Date.now(), Date.now()
    );
    const id = result.lastID;
    return this.getById(id);
  }

  static async getById(id) {
    const db = getDB();
    const user = await db.get(
      `SELECT id, username, email, name, display_name, phone, capacity, earnings_factor, role, is_fired, taking_orders, tg_user_id, email_verified, was_employee, created_at, updated_at
       FROM users WHERE id = ?`,
      id
    );
    return user || null;
  }

  static async getByUsername(username) {
    const db = getDB();
    const user = await db.get(
      `SELECT id, username, email, password_hash, name, display_name, phone, capacity, earnings_factor, role, is_fired, taking_orders, tg_user_id, email_verified, was_employee
       FROM users WHERE username = ?`,
      username
    );
    return user || null;
  }

  static async getByEmail(email) {
    const db = getDB();
    const user = await db.get(
      `SELECT id, username, email, password_hash, name, display_name, phone, capacity, earnings_factor, role, is_fired, taking_orders, tg_user_id, email_verified, was_employee
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
    const allowed = ['name', 'display_name', 'phone', 'capacity', 'earnings_factor', 'role', 'is_fired', 'taking_orders', 'email_verified', 'tg_user_id'];
    const setClauses = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      // Пропускаем undefined, чтобы частичные обновления не затирали остальные поля
      if (allowed.includes(key) && val !== undefined) {
        setClauses.push(`${key} = ?`);
        values.push(val);
      }
    }
    // was_employee выставляется АВТОМАТИЧЕСКИ: выдача staff-роли
    // (employee/moderator/admin/god) означает «стал сотрудником».
    // Флаг НЕ входит в allowed — клиент не может менять его напрямую.
    if (['employee', 'moderator', 'admin', 'god'].includes(fields.role)) {
      setClauses.push('was_employee = ?');
      values.push(1);
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

  /**
   * Удаляет пользователя (используется для отката регистрации,
   * если письмо с кодом подтверждения отправить не удалось)
   */
  static async deleteById(id) {
    const db = getDB();
    await db.run('DELETE FROM users WHERE id = ?', id);
  }

  /**
   * Гости (неподтверждённые аккаунты), созданные раньше cutoffMs —
   * кандидаты на удаление планировщиком (GUEST_TTL_HOURS).
   */
  static async findGuestsOlderThan(cutoffMs) {
    const db = getDB();
    return db.all(
      `SELECT id, username, email, created_at FROM users
       WHERE role = 'guest' AND created_at < ?
       ORDER BY id`,
      cutoffMs
    );
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
   * Получить всех пользователей с фильтрацией (для админа).
   * @param {Object} opts
   * @param {boolean} opts.includeFired - включать уволенных
   * @param {boolean} opts.includeAll - не фильтровать по taking_orders
   * @param {string|null} opts.role - фильтр по роли
   * @param {string|null} opts.cohort - когорта пользователей:
   *   'staff' — только сотрудники и ex-сотрудники (в т.ч. уволенные с
   *   пониженной до 'user' ролью) + все staff-роли;
   *   'users' — только «обычные пользователи» (role='user', ещё НИКОГДА не
   *   были сотрудниками — was_employee=0); гости исключаются всегда.
   *   null/не задан — прежнее поведение (все, кроме гостей).
   */
  static async getAll({ includeFired = false, includeAll = false, role = null, cohort = null } = {}) {
    const db = getDB();
    let sql = `SELECT id, username, email, name, display_name, phone, capacity, earnings_factor, role, is_fired, taking_orders, tg_user_id, email_verified, was_employee, created_at, updated_at FROM users`;
    const conditions = [];
    const params = [];

    // Гости (зарегистрировались, но не подтвердили email) не показываются
    // в списках персонала НИКОГДА — даже с includeFired / includeAll:
    // такой аккаунт не числится нигде (см. также startGuestCleanupChecker,
    // который удаляет гостей через GUEST_TTL_HOURS).
    conditions.push("role <> 'guest'");

    if (cohort === 'staff') {
      // Сотрудники и ex-сотрудники: текущие staff-роли + пониженные до 'user'
      // (уволенные/выведенные из состава — у них was_employee=1)
      conditions.push("(role <> 'user' OR was_employee = 1)");
    } else if (cohort === 'users') {
      // Только никогда-не-сотрудники: роль 'user' и флаг не выставлен
      conditions.push("role = 'user' AND was_employee = 0");
    }

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
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
// uuid не нужен: токены генерируются встроенным crypto (randomBytes / randomInt)
const config = require('../config');
const User = require('../models/User');
const { getDB } = require('../config/database');
const crypto = require('crypto');
const EmailVerification = require('../models/EmailVerification');
const EmailService = require('./EmailService');

class AuthService {
  /**
   * Минимальная валидация данных регистрации.
   * Возвращает массив текстов ошибок (пустой массив — всё валидно).
   */
  static validateRegisterData(data) {
    const errors = [];
    const { username, email, password, capacity } = data;

    // Логин: минимум 6 символов (уникальность проверяет User.create)
    if (!username || typeof username !== 'string' || username.trim().length < 6) {
      errors.push('Логин должен содержать минимум 6 символов');
    }
    // Email: простая проверка формата *@*.*
    if (!email || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) {
      errors.push('Некорректный email');
    }
    // Пароль: минимум 6 символов
    if (!password || typeof password !== 'string' || password.length < 6) {
      errors.push('Пароль должен содержать минимум 6 символов');
    }
    // Количество принтеров: целое число от 1 до 99 (пустое = значение по умолчанию 1)
    if (capacity !== undefined && capacity !== null && capacity !== '') {
      const n = Number(capacity);
      if (!Number.isInteger(n) || n < 1 || n > 99) {
        errors.push(
          'Количество принтеров должно быть целым числом от 1 до 99 (или оставьте поле пустым — тогда будет 1)'
        );
      }
    }
    return errors;
  }

  /**
   * Валидация данных при создании аккаунта администратором.
   * Мягче обычной регистрации:
   *   • логин и пароль — минимум 1 символ;
   *   • количество принтеров — любое положительное целое, без верхней границы;
   *   • из проверок email — только формат *@*.*.
   * Уникальность username/email обеспечивает User.create (already taken).
   * Возвращает массив текстов ошибок (пустой массив — всё валидно).
   */
  static validateAdminRegisterData(data) {
    const errors = [];
    const { username, email, password, capacity, role } = data;

    if (!username || typeof username !== 'string' || username.trim().length < 1) {
      errors.push('Укажите логин (минимум 1 символ)');
    }
    if (!email || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) {
      errors.push('Некорректный email');
    }
    if (!password || typeof password !== 'string' || password.length < 1) {
      errors.push('Укажите пароль (минимум 1 символ)');
    }
    // Количество принтеров: любое положительное целое, без верхней границы
    // (пустое = значение по умолчанию 1)
    if (capacity !== undefined && capacity !== null && capacity !== '') {
      const n = Number(capacity);
      if (!Number.isInteger(n) || n < 1) {
        errors.push(
          'Количество принтеров должно быть положительным целым числом (пусто — тогда будет 1)'
        );
      }
    }
    // Роль — только из белого списка. 'god' (Создатель) вручную не выдаётся:
    // он назначается только синхронизацией из Excel по GOD_EMAIL/GOD_ID.
    if (role !== undefined && role !== null && role !== '') {
      if (!['user', 'employee', 'moderator', 'admin'].includes(role)) {
        errors.push('Недопустимая роль');
      }
    }
    return errors;
  }

  /**
   * Регистрация аккаунта администратором — в обход подтверждения email:
   * аккаунт создаётся сразу подтверждённым (email_verified = 1) и активным
   * с выбранной ролью (по умолчанию 'employee'). Код не генерируется,
   * письмо не отправляется.
   */
  static async adminRegister(data) {
    const { username, email, password, name, phone, capacity, earningsFactor, role } = data;
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const created = await User.create({
      username: String(username).trim(),
      email: String(email).trim(),
      passwordHash,
      // Имя для Персонала: если не указано — используем логин
      name: name && String(name).trim() ? String(name).trim() : String(username).trim(),
      // Отображаемое имя для самого пользователя: по умолчанию логин,
      // он сам сможет поменять его в Профиле
      displayName: String(username).trim(),
      phone: phone || '',
      // Положительность capacity проверена в validateAdminRegisterData;
      // пустое -> дефолт 1
      capacity:
        capacity === undefined || capacity === null || capacity === ''
          ? 1
          : Number(capacity),
      earningsFactor: earningsFactor || 1.0,
      // 'god' не входит в белый список — роль по умолчанию 'employee'
      role: role && ['user', 'employee', 'moderator', 'admin'].includes(role)
        ? role
        : 'employee',
    });
    // Сразу подтверждаем email, чтобы аккаунт был готов к входу без кода
    await User.update(created.id, { email_verified: 1 });
    return User.getById(created.id);
  }

  static async register(data) {
    const { username, email, password, name, phone, capacity, earningsFactor } = data;
    // Проверяем, что username и email уникальны (это делает User.create)
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const user = await User.create({
      username,
      email,
      passwordHash,
      // Регистрация самим пользователем: указанное имя — это его отображаемое
      // имя (display_name), которое он видит в Профиле и может менять сам.
      // name (имя для Персонала) пока ставим из логина — позже его поправит Персонал.
      name: String(username).trim(),
      displayName: name && String(name).trim() ? String(name).trim() : String(username).trim(),
      phone: phone || '',
      capacity: capacity || 1,
      earningsFactor: earningsFactor || 1.0,
      // До подтверждения email пользователь — 'guest'.
      // Роль 'user' он получает после ввода кода из письма (см. verifyEmail).
      role: 'guest',
    });

    // Генерируем код
    const code = this.generateVerificationCode();
    await EmailVerification.create(user.id, code);

    // Отправляем письмо: ЖДЁМ результат, чтобы не отвечать 201,
    // когда письмо реально не ушло (иначе пользователь застрянет без кода).
    try {
      await EmailService.sendVerificationEmail(user.email, user.name, code);
    } catch (err) {
      // Откатываем регистрацию: удаляем коды и пользователя, чтобы
      // username/email освободились и регистрацию можно было повторить.
      console.error('[Auth] Ошибка отправки письма при регистрации:', err.message);
      await EmailVerification.deleteByUserId(user.id);
      await User.deleteById(user.id);
      throw new Error(`Не удалось отправить письмо с кодом подтверждения: ${err.message}`);
    }

    return user; // роль 'guest' — ждём подтверждения email
  }

  static async verifyEmail(code) {
    const record = await EmailVerification.findByCode(code);
    if (!record) throw new Error('Неверный или просроченный код');

    const user = await User.getById(record.user_id);
    if (!user) throw new Error('Неверный или просроченный код');

    // Подтверждаем email и выдаём роль 'user'. Роль меняем только у 'guest',
    // чтобы не понизить роль уже существующего сотрудника/админа.
    const updates = { email_verified: 1 };
    if (user.role === 'guest') {
      updates.role = 'user';
    }
    const updated = await User.update(user.id, updates);

    // Коды одноразовые: чистим все коды этого пользователя
    await EmailVerification.deleteByUserId(user.id);

    return updated;
  }

  /**
   * Повторная отправка кода подтверждения (например, письмо не пришло).
   * Для несуществующего или уже подтверждённого аккаунта — тихий no-op,
   * чтобы не раскрывать факт регистрации по email.
   */
  static async resendCode(email) {
    const user = await User.getByEmail(email);
    if (!user || user.role !== 'guest') return;

    const code = this.generateVerificationCode();
    // Старые коды становятся недействительными
    await EmailVerification.deleteByUserId(user.id);
    await EmailVerification.create(user.id, code);
    await EmailService.sendVerificationEmail(user.email, user.name, code);
  }

  static generateVerificationCode() {
    // 6-значный цифровой код
    return crypto.randomInt(100000, 999999).toString();
  }

  static async login(usernameOrEmail, password) {
    // Ищем по username или email
    let user = await User.getByUsername(usernameOrEmail);
    if (!user) {
      user = await User.getByEmail(usernameOrEmail);
    }
    if (!user) {
      throw new Error('Invalid credentials');
    }
    // Проверяем пароль
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      throw new Error('Invalid credentials');
    }
    // Неподтверждённые (гости) не допускаются до ввода кода из письма
    if (user.role === 'guest') {
      throw new Error('Email not verified');
    }
    // Генерируем токены
    const accessToken = this.generateAccessToken(user.id);
    const refreshToken = this.generateRefreshToken();
    // Сохраняем refresh-токен в БД
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 дней
    const db = getDB();
    await db.run(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      user.id, refreshToken, expiresAt
    );

    // Удаляем пароль из объекта
    delete user.password_hash;
    return {
      user,
      accessToken,
      refreshToken,
    };
  }

  static async refresh(refreshToken) {
    const db = getDB();
    // Ищем токен в БД
    const record = await db.get(
      'SELECT user_id, expires_at FROM refresh_tokens WHERE token = ?',
      refreshToken
    );
    if (!record) {
      throw new Error('Invalid refresh token');
    }
    if (record.expires_at < Date.now()) {
      // Удаляем просроченный
      await db.run('DELETE FROM refresh_tokens WHERE token = ?', refreshToken);
      throw new Error('Refresh token expired');
    }
    // Проверяем, существует ли пользователь
    const user = await User.getById(record.user_id);
    if (!user) {
      throw new Error('User not found');
    }
    // Генерируем новый access token
    const accessToken = this.generateAccessToken(user.id);
    // Можно обновить refresh token (опционально) – для простоты оставляем тот же
    return { accessToken };
  }

  static async logout(refreshToken) {
    const db = getDB();
    await db.run('DELETE FROM refresh_tokens WHERE token = ?', refreshToken);
  }

  static generateAccessToken(userId) {
    return jwt.sign({ userId }, config.jwtSecret, { expiresIn: config.accessTokenExpiry });
  }

  static generateRefreshToken() {
    // Генерируем случайную строку
    return crypto.randomBytes(64).toString('hex');
  }

  static verifyAccessToken(token) {
    try {
      return jwt.verify(token, config.jwtSecret);
    } catch (err) {
      return null;
    }
  }
}

module.exports = AuthService;
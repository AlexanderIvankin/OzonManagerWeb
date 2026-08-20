const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid'); // добавим позже, но можно генерировать простой случайный токен
const config = require('../config');
const User = require('../models/User');
const { getDB } = require('../config/database');
const crypto = require('crypto');
const EmailVerification = require('../models/EmailVerification');
const EmailService = require('./EmailService');

// Для генерации refresh-токенов используем крипто-стойкий случайный
const crypto = require('crypto');

class AuthService {
  static async register(data) {
    const { username, email, password, name, phone, capacity, earningsFactor } = data;
    // Проверяем, что username и email уникальны (это делает User.create)
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const user = await User.create({
      username,
      email,
      passwordHash,
      name,
      phone: phone || '',
      capacity: capacity || 1,
      earningsFactor: earningsFactor || 1.0,
      role: 'user', // по умолчанию
    });

    // Генерируем код
    const code = this.generateVerificationCode();
    await EmailVerification.create(user.id, code);

    // Отправляем письмо (не блокируем ответ)
    EmailService.sendVerificationEmail(user.email, user.name, code)
      .catch(err => console.error('Ошибка отправки письма:', err));

    return user; // но пользователь пока не верифицирован
  }

  static async verifyEmail(code) {
    const record = await EmailVerification.findByCode(code);
    if (!record) throw new Error('Неверный или просроченный код');

    // Подтверждаем email
    await User.update(record.user_id, { email_verified: 1 });
    await EmailVerification.deleteByCode(code);
    return { success: true };
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
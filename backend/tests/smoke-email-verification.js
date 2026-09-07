/**
 * Smoke-тест подтверждения email (запуск: node tests/smoke-email-verification.js из папки backend/).
 * Использует временную БД и стаб вместо реального SMTP, за собой убирает.
 * Проверяет: регистрация -> роль guest -> блокировка логина -> resend -> верный код ->
 * роль user + email_verified -> логин.
 */

// ВАЖНО: env нужно выставить ДО require database-модуля (он читает DB_PATH/BOT_VERSION при загрузке)
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'tmp-smoke-email.db');
process.env.BOT_VERSION = '';

const fs = require('fs');
const { initDB, getDB } = require('../src/config/database');
const User = require('../src/models/User');
const AuthService = require('../src/services/AuthService');
const EmailService = require('../src/services/EmailService');

// Стаб вместо реального SMTP: перехватываем код подтверждения
let lastSentCode = null;
let sentCount = 0;
EmailService.sendVerificationEmail = async (email, name, code) => {
  lastSentCode = code;
  sentCount += 1;
  console.log(`[Стаб Email] Код ${code} -> ${email}`);
  return { messageId: 'stub' };
};

(async () => {
  let createdUserId = null;
  try {
    console.log('=== Smoke-тест подтверждения email ===');
    await initDB();
    const db = getDB();

    const username = 'smoke_verify_user';
    const email = 'smoke_verify_user@example.com';
    // Чистим возможный мусор от прошлого запуска
    await db.run('DELETE FROM users WHERE username = ?', username);

    // 0. Минимальная валидация регистрационных данных
    const badLogin = AuthService.validateRegisterData({ username: 'abc12', email: 'a@b.ru', password: 'secret123' });
    const badEmail = AuthService.validateRegisterData({ username: 'abcdef', email: 'not-an-email', password: 'secret123' });
    const badPass = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: '12345' });
    const capZero = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: 0 });
    const capOver = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: 100 });
    const capNeg = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: -1 });
    const capFrac = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: 2.5 });
    const okOne = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: 1 });
    const okStr99 = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: '99' });
    const okNoCap = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123' });
    console.log('0. Валидация: логин/Email/пароль/cap0/cap100/cap-1/cap2.5 отклонены:',
      badLogin.length === 1 && badEmail.length === 1 && badPass.length === 1 &&
      capZero.length === 1 && capOver.length === 1 && capNeg.length === 1 && capFrac.length === 1);
    console.log('   Валидация: cap 1 / "99" / без capacity приняты:',
      okOne.length === 0 && okStr99.length === 0 && okNoCap.length === 0);
    if (badLogin.length !== 1 || badEmail.length !== 1 || badPass.length !== 1 ||
        capZero.length !== 1 || capOver.length !== 1 || capNeg.length !== 1 || capFrac.length !== 1 ||
        okOne.length !== 0 || okStr99.length !== 0 || okNoCap.length !== 0) {
      throw new Error('Валидация регистрационных данных работает неверно');
    }

    // 1. Регистрация: роль guest, код "отправлен", без capacity -> дефолт 1
    const user = await AuthService.register({
      username, email, password: 'secret123', name: 'Smoke Test',
    });
    createdUserId = user.id;
    console.log('1. Регистрация: role =', user.role, ', capacity =', user.capacity);
    if (user.role !== 'guest') throw new Error('Ожидалась роль guest');
    if (user.capacity !== 1) throw new Error('Дефолтный capacity должен быть 1');
    if (!lastSentCode) throw new Error('Код не отправлен');

    // 2. Логин до подтверждения запрещён
    let blocked = false;
    try {
      await AuthService.login(username, 'secret123');
    } catch (e) {
      blocked = e.message === 'Email not verified';
    }
    console.log('2. Логин гостя заблокирован:', blocked);
    if (!blocked) throw new Error('Логин гостя не заблокирован');

    // 3. Неверный код отклоняется
    let wrongRejected = false;
    try {
      await AuthService.verifyEmail(lastSentCode === '000000' ? '111111' : '000000');
    } catch (e) {
      wrongRejected = e.message === 'Неверный или просроченный код';
    }
    console.log('3. Неверный код отклонён:', wrongRejected);
    if (!wrongRejected) throw new Error('Неверный код принят');

    // 4. Resend: старый код перестаёт действовать, новый отправляется
    const oldCode = lastSentCode;
    await AuthService.resendCode(email);
    if (lastSentCode === oldCode) throw new Error('Новый код не сгенерирован');
    let oldRejected = false;
    try {
      await AuthService.verifyEmail(oldCode);
    } catch (e) {
      oldRejected = true;
    }
    console.log('4. Resend: старый код недействителен:', oldRejected);
    if (!oldRejected) throw new Error('Старый код всё ещё действует');

    // 5. Верный код -> роль user + email_verified + все коды удалены
    const verified = await AuthService.verifyEmail(lastSentCode);
    const fresh = await User.getById(user.id);
    console.log('5. Подтверждение: role =', fresh.role, ', email_verified =', verified.email_verified);
    if (fresh.role !== 'user') throw new Error('Роль не изменилась на user');
    if (verified.email_verified !== 1) throw new Error('email_verified не установлен');
    const codesLeft = await db.get(
      'SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?', user.id
    );
    if (codesLeft.n !== 0) throw new Error('Коды не удалены после подтверждения');

    // 6. Логин после подтверждения работает
    const loginResult = await AuthService.login(username, 'secret123');
    console.log('6. Логин после подтверждения: OK, role =', loginResult.user.role);
    if (loginResult.user.role !== 'user') throw new Error('Неожиданная роль при логине');

    // 7. Resend для подтверждённого аккаунта — тихий no-op (письмо не уходит)
    const sentBefore = sentCount;
    await AuthService.resendCode(email);
    if (sentCount !== sentBefore) throw new Error('Resend для подтверждённого отправил письмо');
    console.log('7. Resend для подтверждённого: OK (no-op)');

    // 8. Resend для несуществующего email — тихий no-op (не раскрываем регистрацию)
    await AuthService.resendCode('no-such-user@example.com');
    if (sentCount !== sentBefore) throw new Error('Resend для несуществующего отправил письмо');
    console.log('8. Resend для несуществующего: OK (no-op)');

    console.log('=== Smoke-тест пройден ✅ ===');
    process.exitCode = 0;
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    // Чистим за собой: тестового пользователя и временную БД
    try {
      const db = getDB();
      if (createdUserId) {
        await db.run('DELETE FROM email_verifications WHERE user_id = ?', createdUserId);
        await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', createdUserId);
        await db.run('DELETE FROM users WHERE id = ?', createdUserId);
      }
      await db.close();
    } catch (e) { /* БД могла не открыться — не критично */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch (e) { /* нет файла */ }
    }
  }
})();

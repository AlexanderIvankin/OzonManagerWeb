/**
 * Smoke-тест очистки неподтверждённых аккаунтов (запуск: node tests/smoke-guest-cleanup.js
 * из папки backend/). Использует временную БД и стаб вместо реального SMTP, за собой убирает.
 *
 * Проверяет AuthService.cleanupGuestAccounts — то же, что ежечасно делает планировщик
 * (scheduler.startGuestCleanupChecker, TTL — GUEST_TTL_HOURS, по умолчанию 24 ч):
 *   • «старый» гость (email не подтверждён дольше TTL) удаляется целиком вместе с
 *     кодами подтверждения, refresh-токенами и связями со складами;
 *   • «свежий» гость остаётся ждать подтверждения (вне команды: is_fired = 1,
 *     taking_orders = 0, в списке пользователей не виден), его код не тронут;
 *   • просроченные коды других аккаунтов («легаси») вычищаются, сами аккаунты живут;
 *   • повторный прогон идемпотентен.
 */

// ВАЖНО: env нужно выставить ДО require database-модуля (он читает DB_PATH/BOT_VERSION при загрузке)
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'tmp-smoke-guest.db');
process.env.BOT_VERSION = '';

const fs = require('fs');
const { initDB, getDB } = require('../src/config/database');
const User = require('../src/models/User');
const AuthService = require('../src/services/AuthService');
const EmailService = require('../src/services/EmailService');

// Стаб вместо реального SMTP: код подтверждения в тесте не нужен
EmailService.sendVerificationEmail = async (email) => {
  console.log(`[Стаб Email] Письмо -> ${email}`);
  return { messageId: 'stub' };
};

const HOUR_MS = 60 * 60 * 1000;
const TTL_HOURS = 24;
const TEST_EMAIL_SUFFIX = '@smoke-guests.local';

(async () => {
  let staleGuestId = null;
  let freshGuestId = null;
  let legacyUserId = null;
  try {
    console.log('=== Smoke-тест очистки неподтверждённых аккаунтов ===');
    await initDB();
    const db = getDB();

    // Чистим мусор от прошлых запусков (коды/токены уйдут каскадом)
    await db.run(`DELETE FROM users WHERE email LIKE '%${TEST_EMAIL_SUFFIX}'`);

    // 1. «Старый» гость: регистрируемся и «старим» запись на TTL + 1 час
    const stale = await AuthService.register({
      username: 'smoke_stale_guest',
      email: `stale${TEST_EMAIL_SUFFIX}`,
      password: 'secret123',
    });
    staleGuestId = stale.user.id;
    const staleCreatedAt = Date.now() - (TTL_HOURS + 1) * HOUR_MS;
    await db.run(
      'UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?',
      staleCreatedAt, staleCreatedAt, staleGuestId
    );
    // Его код тоже просрочен (письмо не пришло / код давно истёк)
    await db.run(
      'UPDATE email_verifications SET created_at = ?, expires_at = ? WHERE user_id = ?',
      staleCreatedAt, Date.now() - HOUR_MS, staleGuestId
    );
    // Успевшая появиться сессия гостя — тоже должна исчезнуть
    await db.run(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      staleGuestId, 'smoke_guest_token', Date.now() + 7 * 24 * HOUR_MS
    );
    // Связь со складом (страховка: у гостя её быть не должно, но чистим).
    // Склад сначала создаём — user_warehouses ссылается на warehouses
    await db.run(
      'INSERT OR IGNORE INTO warehouses (warehouse_id, name) VALUES (?, ?)',
      'smoke-warehouse', 'Smoke Warehouse'
    );
    await db.run(
      'INSERT OR IGNORE INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)',
      staleGuestId, 'smoke-warehouse'
    );
    console.log('1. «Старый» гость #' + staleGuestId + ': role =', stale.user.role,
      ', is_fired =', stale.user.is_fired, ', возраст > TTL');

    // 2. «Свежий» гость — только что зарегистрировался, должен остаться
    const fresh = await AuthService.register({
      username: 'smoke_fresh_guest',
      email: `fresh${TEST_EMAIL_SUFFIX}`,
      password: 'secret123',
    });
    freshGuestId = fresh.user.id;
    console.log('2. «Свежий» гость #' + freshGuestId + ': ожидает подтверждения');

    // 3. «Легаси»-аккаунт (не гость) с просроченным кодом подтверждения
    const legacy = await User.create({
      username: 'smoke_legacy_user',
      email: `legacy${TEST_EMAIL_SUFFIX}`,
      passwordHash: 'not-a-real-hash',
      name: 'Legacy',
      role: 'user',
    });
    legacyUserId = legacy.id;
    await db.run(
      'INSERT INTO email_verifications (user_id, code, expires_at, created_at) VALUES (?, ?, ?, ?)',
      legacyUserId, '000001', Date.now() - HOUR_MS, Date.now() - 2 * HOUR_MS
    );

    // 4. Прогон очистки (то же, что делает планировщик раз в час)
    const result = await AuthService.cleanupGuestAccounts(TTL_HOURS);
    console.log('4. Очистка: удалено аккаунтов =', result.deletedUsers,
      ', просроченных кодов =', result.deletedCodes);

    // 5. «Старый» гость удалён целиком, связанных данных не осталось
    const staleAfter = await User.getById(staleGuestId);
    const staleCodes = await db.get(
      'SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?', staleGuestId
    );
    const staleTokens = await db.get(
      'SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?', staleGuestId
    );
    const staleWarehouses = await db.get(
      'SELECT COUNT(*) AS n FROM user_warehouses WHERE user_id = ?', staleGuestId
    );
    console.log('5. «Старый» гость: запись =', staleAfter, ', коды =', staleCodes.n,
      ', токены =', staleTokens.n, ', склады =', staleWarehouses.n);
    if (staleAfter !== null) throw new Error('«Старый» гость не удалён');
    if (staleCodes.n !== 0 || staleTokens.n !== 0 || staleWarehouses.n !== 0) {
      throw new Error('Остались связанные данные удалённого гостя');
    }

    // 6. «Свежий» гость на месте: вне команды, ждёт подтверждения, код жив
    const freshAfter = await User.getById(freshGuestId);
    const freshCodes = await db.get(
      'SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?', freshGuestId
    );
    const visible = await User.getAll({ includeFired: true, includeAll: true });
    if (!freshAfter) throw new Error('«Свежий» гость удалён раньше TTL');
    console.log('6. «Свежий» гость: role =', freshAfter.role, ', is_fired =', freshAfter.is_fired,
      ', taking_orders =', freshAfter.taking_orders, ', коды =', freshCodes.n);
    if (freshAfter.role !== 'guest' || freshAfter.is_fired !== 1 || freshAfter.taking_orders !== 0) {
      throw new Error('«Свежий» гость должен быть вне команды');
    }
    if (freshCodes.n !== 1) throw new Error('Код «свежего» гостя не должен удаляться');
    if (visible.some((u) => u.id === freshGuestId)) {
      throw new Error('Гость виден в списке пользователей');
    }

    // 7. Просроченный «легаси»-код удалён, сам аккаунт остался
    const legacyCodes = await db.get(
      'SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?', legacyUserId
    );
    const legacyAfter = await User.getById(legacyUserId);
    console.log('7. «Легаси»-код: коды =', legacyCodes.n, ', аккаунт жив =', legacyAfter !== null);
    if (legacyCodes.n !== 0) throw new Error('Просроченный код не удалён');
    if (!legacyAfter) throw new Error('Аккаунт с просроченным кодом удалён зря');
    if (result.deletedUsers !== 1) throw new Error('Ожидалось удаление ровно одного гостя');
    if (result.deletedCodes < 1) throw new Error('Просроченные коды не вычищены');

    // 8. Повторный прогон идемпотентен
    const again = await AuthService.cleanupGuestAccounts(TTL_HOURS);
    console.log('8. Повторный прогон: удалено аккаунтов =', again.deletedUsers);
    if (again.deletedUsers !== 0) throw new Error('Повторный прогон удалил лишнее');

    console.log('=== Smoke-тест пройден ✅ ===');
    process.exitCode = 0;
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    // Чистим за собой: тестовые аккаунты и временную БД
    try {
      const db = getDB();
      for (const id of [staleGuestId, freshGuestId, legacyUserId]) {
        if (!id) continue;
        await db.run('DELETE FROM email_verifications WHERE user_id = ?', id);
        await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', id);
        await db.run('DELETE FROM user_warehouses WHERE user_id = ?', id);
        await db.run('DELETE FROM users WHERE id = ?', id);
      }
      await db.run('DELETE FROM warehouses WHERE warehouse_id = ?', 'smoke-warehouse');
      await db.close();
    } catch (e) { /* БД могла не открыться — не критично */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch (e) { /* нет файла */ }
    }
  }
})();

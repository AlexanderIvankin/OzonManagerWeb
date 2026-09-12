/**
 * Smoke-тест напоминаний awaiting_deliver (запуск: node tests/smoke-deliver-reminder.js
 * из папки backend/). Поднимает тестовые данные в основной и оповещений БД,
 * запускает один прогон scheduler.runAwaitingDeliverReminder и удаляет за собой.
 * Ozon API переключён в MOCK-режим: fetchAwaitingDeliverOrders вернёт заказ '12345-1'.
 */
process.env.OZON_MOCK_MODE = 'true';
require('dotenv').config();

const { initDB, getDB } = require('../src/config/database');
const { initNotificationsDB, getNotificationsDB } = require('../src/config/notificationsDatabase');
const { User } = require('../src/models');
const Notification = require('../src/models/Notification');
const OzonService = require('../src/services/OzonService');
const scheduler = require('../src/scheduler');

const TEST_MARK = 'smokeReminder';
// Уникальный тестовый заказ: не пересекается с данными dev-БД ('12345-1' из MOCK-режима)
const stamp = Date.now();
const TEST_ORDER = `${TEST_MARK}-1_${stamp}`;

(async () => {
  const employee = { id: null };
  const staffUser = { id: null };
  let db;
  let ndb;

  // Подменяем список awaiting_deliver уникальным тестовым заказом
  // (чтобы не зависеть от '12345-1' MOCK-режима и чужих данных dev-БД).
  const originalFetch = OzonService.fetchAwaitingDeliverOrders;
  OzonService.fetchAwaitingDeliverOrders = async () => [
    { posting_number: TEST_ORDER, products: [{ name: 'Тестовый товар', quantity: 1 }] },
  ];

  try {
    console.log('=== Smoke-тест напоминаний awaiting_deliver ===');
    await initDB();
    await initNotificationsDB();
    db = getDB();
    ndb = getNotificationsDB();

    // 1. Тестовые пользователи: сотрудник + модератор (получатель журнала)
    const stamp = Date.now();
    const emp = await User.create({
      username: `${TEST_MARK}_emp_${stamp}`,
      email: `${TEST_MARK}_emp_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeReminderСотрудник',
      role: 'user',
    });
    const mod = await User.create({
      username: `${TEST_MARK}_mod_${stamp}`,
      email: `${TEST_MARK}_mod_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeReminderМодератор',
      role: 'moderator',
    });
    employee.id = emp.id;
    staffUser.id = mod.id;
    console.log(`Созданы: сотрудник #${emp.id}, модератор #${mod.id}`);

    // 2. Назначение: заказ завершён 5 дней назад и всё ещё awaiting_deliver
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    await db.run(
      `INSERT INTO assignments (order_id, user_id, assigned_at, completed_at, status)
       VALUES (?, ?, ?, ?, 'completed')`,
      TEST_ORDER, emp.id, fiveDaysAgo, fiveDaysAgo
    );
    await db.run(
      `INSERT INTO earnings_history (user_id, order_id, amount, calculated_at)
       VALUES (?, ?, ?, ?)`,
      emp.id, TEST_ORDER, 150, fiveDaysAgo
    );

    // 3. Первый прогон: должно отправиться 1 напоминание
    await scheduler.runAwaitingDeliverReminder(24);

    // 4. Проверки
    const empNotifs = await Notification.getByRecipient(emp.id, { audience: 'user', limit: 20 });
    const reminder = empNotifs.items.find((n) => n.type === 'deliver_reminder');
    console.log(
      `Личное напоминание сотруднику: ${!!reminder}, «${reminder?.title}»\n  текст: "${reminder?.message?.slice(0, 160)}"`
    );
    if (!reminder) throw new Error('Напоминание сотруднику не создано');

    const staffNotifs = await Notification.getByRecipient(mod.id, { audience: 'staff', limit: 20 });
    const staffCopy = staffNotifs.items.find((n) => n.type === 'deliver_reminder');
    const summary = staffNotifs.items.find((n) => n.type === 'deliver_reminder_summary');
    console.log(
      `Копия персоналу: ${!!staffCopy}, сводка: ${!!summary}, «${summary?.message}»`
    );
    if (!staffCopy) throw new Error('Копия в журнал персонала не создана');
    if (!summary) throw new Error('Сводка персоналу не создана');

    const assignment = await db.get('SELECT * FROM assignments WHERE order_id = ?', TEST_ORDER);
    console.log(
      `Маркер напоминания: sent_at=${assignment.deliver_reminder_sent_at}, count=${assignment.deliver_reminder_count}`
    );
    if (!assignment.deliver_reminder_sent_at) throw new Error('deliver_reminder_sent_at не проставлен');
    if (assignment.deliver_reminder_count !== 1) throw new Error('deliver_reminder_count != 1');

    // 5. Повторный прогон в тот же день: напоминаний больше не должно быть
    await scheduler.runAwaitingDeliverReminder(24);
    const after = await Notification.getByRecipient(emp.id, { audience: 'user', limit: 20 });
    const remindersAfter = after.items.filter((n) => n.type === 'deliver_reminder').length;
    console.log(`Повторный прогон: напоминаний с type=deliver_reminder всё ещё ${remindersAfter} (ожидалось 1)`);
    if (remindersAfter !== 1) throw new Error('Повторное напоминание в тот же день — дедупликация сломана');

    console.log('=== Smoke-тест пройден ✅ ===');
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    // Восстанавливаем подменённый метод и чистим тестовые данные
    OzonService.fetchAwaitingDeliverOrders = originalFetch;
    try {
      await ndb.run(`DELETE FROM notifications WHERE type LIKE 'deliver_reminder%' OR payload LIKE '%${TEST_MARK}%'`);
      await db.run(`DELETE FROM assignments WHERE order_id = ?`, TEST_ORDER);
      await db.run(`DELETE FROM earnings_history WHERE order_id = ?`, TEST_ORDER);
      if (employee.id) await db.run('DELETE FROM users WHERE id = ?', employee.id);
      if (staffUser.id) await db.run('DELETE FROM users WHERE id = ?', staffUser.id);
      console.log('Тестовые данные удалены');
    } catch (cleanupErr) {
      console.error('Ошибка очистки:', cleanupErr.message);
    }
  }
})();
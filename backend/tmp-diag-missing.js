// Временная диагностика: доходит ли оповещение персоналу models_missing,
// когда в заказе НЕТ моделей ни по одному артикулу. Запуск: node tmp-diag-missing.js
process.env.OZON_MOCK_MODE = 'true';
require('dotenv').config();

const { initDB, getDB } = require('./src/config/database');
const { initNotificationsDB, getNotificationsDB } = require('./src/config/notificationsDatabase');
const { User } = require('./src/models');
const ModelService = require('./src/services/ModelService');

(async () => {
  await initDB();
  await initNotificationsDB();
  const db = getDB();
  const ndb = getNotificationsDB();
  const stamp = Date.now();

  const emp = await User.create({
    username: `diag_emp_${stamp}`,
    email: `diag_emp_${stamp}@diag.local`,
    passwordHash: 'x',
    name: 'ДиагностикаСотрудник',
    role: 'employee',
  });
  const mod = await User.create({
    username: `diag_mod_${stamp}`,
    email: `diag_mod_${stamp}@diag.local`,
    passwordHash: 'x',
    name: 'ДиагностикаМодератор',
    role: 'moderator',
  });

  console.log('1) Получатели журнала персонала (роли admin/moderator/god, is_fired=0):');
  console.log(await db.all(
    "SELECT id, name, role, is_fired FROM users WHERE role IN ('admin','moderator','god') AND is_fired = 0"
  ));

  const orderId = `DIAG-${stamp}`;
  console.log('2) Вызываем issueForAssignment с товаром БЕЗ модели...');
  const res = await ModelService.issueForAssignment(orderId, emp.id, emp, {
    products: [{ name: 'Товар без модели', offer_id: `DIAG-NOMODEL-${stamp}`, quantity: 1 }],
  });
  console.log('   summary:', JSON.stringify(res));

  await new Promise((r) => setTimeout(r, 1000));
  console.log('3) Строки в notifications.db (type LIKE models%):');
  console.log(await ndb.all(
    "SELECT id, recipient_id, audience, type, title FROM notifications WHERE type LIKE 'models%' ORDER BY id DESC LIMIT 10"
  ));

  console.log('4) Последние ошибки сервера (server_errors):');
  console.log(await ndb.all(
    "SELECT id, level, source, substr(message,1,120) AS msg FROM server_errors ORDER BY id DESC LIMIT 5"
  ));

  // Очистка
  await ndb.run('DELETE FROM notifications WHERE payload LIKE ?', `%${orderId}%`);
  await db.run("DELETE FROM issued_models WHERE offer_id LIKE 'DIAG-%'");
  await db.run('DELETE FROM users WHERE id IN (?, ?)', emp.id, mod.id);
  console.log('Очистка выполнена');
  process.exit(0);
})().catch((err) => {
  console.error('ДИАГНОСТИКА УПАЛА:', err);
  process.exit(1);
});
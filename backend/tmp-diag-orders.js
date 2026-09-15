// Временная диагностика: что записано в notifications.db по КОНКРЕТНЫМ заказам
// (проверяем, есть ли staff-копия «нет 3D-моделей» рядом с user-копией).
require('dotenv').config();
const { initDB } = require('./src/config/database');
const { initNotificationsDB, getNotificationsDB } = require('./src/config/notificationsDatabase');

const ORDERS = process.argv.slice(2);

(async () => {
  await initDB();
  await initNotificationsDB();
  const ndb = getNotificationsDB();
  for (const orderId of ORDERS) {
    const rows = await ndb.all(
      `SELECT id, recipient_id, audience, type, order_id, created_at
       FROM notifications
       WHERE order_id = ? OR payload LIKE ?
       ORDER BY id`,
      orderId, `%${orderId}%`
    );
    console.log(`\n=== ${orderId} — записей: ${rows.length} ===`);
    for (const r of rows) {
      console.log(
        `${r.id} | ${r.audience} | user_id=${r.recipient_id} | ${r.type} | ` +
        `${new Date(Number(r.created_at)).toLocaleString('ru-RU')}`
      );
    }
  }
  const errors = await ndb.all(
    "SELECT id, source, substr(message,1,150) AS msg, created_at FROM server_errors WHERE message LIKE '%transaction%' ORDER BY id DESC LIMIT 10"
  );
  console.log(`\n=== server_errors с 'transaction': ${errors.length} ===`);
  for (const e of errors) {
    console.log(`${e.id} | ${e.source} | ${new Date(Number(e.created_at)).toLocaleString('ru-RU')} | ${e.msg}`);
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
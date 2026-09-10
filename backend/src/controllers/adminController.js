const fs = require('fs');
const path = require('path');
const { User, Assignment, UserStats, Earnings, Warehouse, ProductStat } = require('../models');
const SyncService = require('../services/SyncService');
const OzonService = require('../services/OzonService');
const OrderService = require('../services/OrderService');
const EarningsService = require('../services/EarningsService');
const MaterialsService = require('../services/MaterialsService');
const BackupService = require('../services/BackupService');
const ProductStatsService = require('../services/ProductStatsService');
const AuthService = require('../services/AuthService');
const NotificationService = require('../services/NotificationService');
const scheduler = require('../scheduler');
const { getDB, getDBPath } = require('../config/database')
const { getLocalTimestamp, getDbBaseName, getVersionedFileName } = require('../utils');

/**
 * Перегенерирует Excel-файлы сотрудников на сервере (team-info.xlsx и employees-db.xlsx),
 * чтобы они всегда соответствовали состоянию БД после действий админа на сайте.
 * Ошибки перегенерации не критичны — логируем и не выбрасываем.
 */
async function refreshServerExports() {
  try {
    await SyncService.exportTeamInfoXlsx(null, false, 'team-info.xlsx', { syncWarehouses: false });
    await SyncService.exportTeamInfoXlsx(null, true, 'employees-db.xlsx', { syncWarehouses: false });
    console.log('[adminController] Excel-файлы сотрудников перегенерированы');
  } catch (err) {
    console.error('[adminController] Ошибка перегенерации Excel-файлов:', err.message);
  }
}

/**
 * Получить список всех пользователей (с фильтрацией)
 */
exports.getUsers = async (req, res, next) => {
  try {
    const { includeFired, includeAll, role, withWarehouses } = req.query;
    const users = await User.getAll({
      includeFired: includeFired === 'true',
      includeAll: includeAll === 'true',
      role
    });
    // Дополнительно: склады (приоритеты) и количество активных заказов
    // для каждого пользователя — используется при назначении заказов,
    // чтобы показать список «приоритетных по складу» сотрудников (как в боте)
    if (withWarehouses === 'true') {
      const db = getDB();
      // Все связи пользователь-склад одним запросом
      const links = await db.all(`
        SELECT uw.user_id, w.warehouse_id, w.name, w.address, w.is_rfbs
        FROM user_warehouses uw
        JOIN warehouses w ON uw.warehouse_id = w.warehouse_id
        ORDER BY w.name
      `);
      // Количество активных заказов всех пользователей одним запросом
      const counts = await db.all(
        "SELECT user_id, COUNT(*) as count FROM assignments WHERE status = 'assigned' GROUP BY user_id"
      );
      const warehousesMap = new Map();
      for (const link of links) {
        if (!warehousesMap.has(link.user_id)) warehousesMap.set(link.user_id, []);
        warehousesMap.get(link.user_id).push({
          warehouse_id: link.warehouse_id,
          name: link.name,
          address: link.address,
          is_rfbs: !!link.is_rfbs,
        });
      }
      const countsMap = new Map(counts.map((c) => [c.user_id, c.count]));
      res.json(users.map((u) => ({
        ...u,
        warehouses: warehousesMap.get(u.id) || [],
        active_count: countsMap.get(u.id) || 0,
      })));
      return;
    }
    res.json(users);
  } catch (err) {
    next(err);
  }
};

/**
 * Получить детали пользователя по ID (со статистикой и активными заказами)
 */
exports.getUserById = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const user = await User.getWithDetails(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Дополнительно получаем склады пользователя
    const warehouses = await Warehouse.getUserWarehouses(userId);
    res.json({ ...user, warehouses });
  } catch (err) {
    next(err);
  }
};

/**
 * Обновить пользователя (админ)
 */
exports.updateUser = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { name, phone, capacity, earnings_factor, role, is_fired, taking_orders } = req.body;
    const target = await User.getById(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    // --- Защита Создателя (роль 'god') ---
    // Редактировать профиль Создателя может только сам Создатель
    if (target.role === 'god' && req.user.role !== 'god') {
      return res.status(403).json({ error: 'Профиль Создателя может редактировать только Создатель' });
    }
    // Роль 'god' нельзя выдать или снять вручную — только синхронизацией из Excel
    if (role !== undefined && role !== target.role && (role === 'god' || target.role === 'god')) {
      return res.status(403).json({ error: "Роль 'god' (Создатель) управляется только синхронизацией" });
    }
    // Создателя нельзя уволить — даже ему самому
    if (target.role === 'god' && (is_fired === true || is_fired === 1)) {
      return res.status(403).json({ error: 'Создателя нельзя уволить' });
    }
    const user = await User.update(userId, {
      name,
      phone,
      capacity,
      earnings_factor,
      role,
      is_fired,
      taking_orders
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Перегенерируем Excel-файлы сотрудников на сервере
    await refreshServerExports();
    res.json(user);
  } catch (err) {
    next(err);
  }
};

/**
 * Уволить пользователя (пометить is_fired = 1)
 */
exports.fireUser = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const target = await User.getById(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Создателя нельзя уволить, удалить или понизить
    if (target.role === 'god') {
      return res.status(403).json({ error: 'Создателя нельзя уволить' });
    }
    // При увольнении выключаем приём заказов и понижаем роль до 'user',
    // чтобы уволенный не имел доступа к сотрудническим возможностям
    const user = await User.update(userId, { is_fired: 1, taking_orders: 0, role: 'user' });
    // Снять все активные назначения
    const db = require('../config/database').getDB();
    await db.run('DELETE FROM assignments WHERE user_id = ? AND status = "assigned"', userId);
    // Перегенерируем Excel-файлы сотрудников на сервере
    await refreshServerExports();
    res.json({ message: 'User fired successfully' });
  } catch (err) {
    next(err);
  }
};

/**
 * Создать аккаунт администратором — в обход подтверждения email.
 * Аккаунт создаётся сразу подтверждённым (email_verified = 1) и активным
 * с выбранной ролью (по умолчанию 'employee'). Правила мягче обычной
 * регистрации: логин/пароль от 1 символа, capacity — любое положительное
 * целое, email — только формат. Уникальность username/email обязательна.
 */
exports.createUserByAdmin = async (req, res, next) => {
  try {
    const { username, email, password, name, phone, capacity, earningsFactor, role } = req.body;
    const validationErrors = AuthService.validateAdminRegisterData({
      username, email, password, capacity, role,
    });
    if (validationErrors.length > 0) {
      // error — текст для показа, errors — массив по полям (структурированно)
      return res.status(400).json({
        error: validationErrors.join('. '),
        errors: validationErrors,
      });
    }
    const user = await AuthService.adminRegister({
      username, email, password, name, phone, capacity, earningsFactor, role,
    });
    // Перегенерируем Excel-файлы сотрудников на сервере
    await refreshServerExports();
    res.status(201).json({
      user,
      message: `Аккаунт ${user.username} создан и подтверждён (роль: ${user.role})`,
    });
  } catch (err) {
    if (err.message.includes('already taken')) {
      const what = err.message.startsWith('username') ? 'Логин' : 'Email';
      return res.status(409).json({ error: `${what} уже занят` });
    }
    next(err);
  }
};

/**
 * 🎃 Пасхалка Создателя.
 * Фейковая статистика хранится в ОБЫЧНЫХ ПЕРЕМЕННЫХ на бэкенде (в памяти
 * процесса) — никакая реальная БД не используется, это просто шутка.
 * Значения сбрасываются при перезапуске сервера.
 */
let godFakeStats = {
  total_orders: 1337,
  canceled_orders: 666,
  earnings_total: 999999999.99,
  total_amount: 666666666.66,
};

/**
 * Статистика команды для вкладки «Статистика» (только персонал).
 * Агрегируется на лету из двух таблиц:
 *   • user_stats      — total_orders, canceled_orders, total_amount
 *   • earnings_history — SUM(amount) = заработок сотрудника за всё время
 * Для строки Создателя (role = 'god') вместо реальных данных подставляются
 * фейковые значения из переменной godFakeStats (fake: true).
 */
exports.getStaffStats = async (req, res, next) => {
  try {
    const includeFired = req.query.includeFired === 'true';
    const db = getDB();
    const rows = await db.all(
      `
      SELECT u.id, u.name, u.username, u.role, u.is_fired,
             COALESCE(us.total_orders, 0)   AS total_orders,
             COALESCE(us.canceled_orders, 0) AS canceled_orders,
             COALESCE(us.total_amount, 0)   AS total_amount,
             COALESCE(SUM(eh.amount), 0)    AS earnings_total
      FROM users u
      LEFT JOIN user_stats us ON us.user_id = u.id
      LEFT JOIN earnings_history eh ON eh.user_id = u.id
      ${includeFired ? '' : 'WHERE u.is_fired = 0'}
      GROUP BY u.id
      ORDER BY u.id
      `
    );
    const stats = rows.map((r) =>
      r.role === 'god' ? { ...r, ...godFakeStats, fake: true } : { ...r, fake: false },
    );
    res.json(stats);
  } catch (err) {
    next(err);
  }
};

/**
 * 🎃 Редактирование фейковой статистики Создателя — доступно только роли god
 * (маршрут дополнительно защищён authorize('god')). Значения живут в памяти
 * до перезапуска сервера.
 */
exports.updateGodFakeStats = async (req, res, next) => {
  try {
    const { total_orders, canceled_orders, total_amount, earnings_total } = req.body;
    const errors = [];
    const updates = {};

    if (total_orders !== undefined) {
      const n = Number(total_orders);
      if (!Number.isInteger(n) || n < 0) errors.push('total_orders: целое число ≥ 0');
      else updates.total_orders = n;
    }
    if (canceled_orders !== undefined) {
      const n = Number(canceled_orders);
      if (!Number.isInteger(n) || n < 0) errors.push('canceled_orders: целое число ≥ 0');
      else updates.canceled_orders = n;
    }
    if (total_amount !== undefined) {
      const n = Number(total_amount);
      if (!Number.isFinite(n) || n < 0) errors.push('total_amount: число ≥ 0');
      else updates.total_amount = n;
    }
    if (earnings_total !== undefined) {
      const n = Number(earnings_total);
      if (!Number.isFinite(n) || n < 0) errors.push('earnings_total: число ≥ 0');
      else updates.earnings_total = n;
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('. '), errors });
    }

    godFakeStats = { ...godFakeStats, ...updates };
    res.json({
      message: 'Статистика Создателя обновлена 🎃 (живёт в памяти до перезапуска сервера)',
      stats: { ...godFakeStats, fake: true },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Синхронизация сотрудников из Excel
 */
exports.syncEmployees = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const result = await SyncService.syncFromExcel(req.file.path, req.user.id);
    res.json({ message: 'Sync completed', ...result });
  } catch (err) {
    next(err);
  }
};

/**
 * Синхронизация сотрудников из серверного файла team-info.xlsx
 * (лежит в папке backend, генерируется экспортом/ботом).
 * Используется кнопкой «Обновить» на странице «Пользователи»:
 * подтягивает данные из Excel, в т.ч. выдаёт роль 👻 Создателя
 * по GOD_EMAIL/GOD_ID из .env.
 */
exports.syncEmployeesServerFile = async (req, res, next) => {
  try {
    const fileName = getVersionedFileName('team-info', 'xlsx');
    const filePath = path.join(__dirname, '../../', fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: `Файл ${fileName} не найден на сервере. Сначала выгрузите его через «Экспорт данных».`,
      });
    }
    const result = await SyncService.syncFromExcel(filePath, req.user.id);
    res.json({ message: 'Sync completed', ...result });
  } catch (err) {
    next(err);
  }
};

/**
 * Экспорт базы данных сотрудников и складов в Excel
 */
exports.exportTeamInfo = async (req, res, next) => {
  try {
    const includeFired = req.query.includeFired === 'true';
    const filePath = await SyncService.exportTeamInfoXlsx(req.user.id, includeFired);
    res.download(filePath);
  } catch (err) {
    console.error('[exportTeamInfo] Ошибка:', err);
    next(err);
  }
};

/**
 * Получить склады
 */
exports.getWarehouses = async (req, res, next) => {
  try {
    const warehouses = await Warehouse.getAll();
    res.json(warehouses);
  } catch (err) {
    next(err);
  }
};

/**
 * Синхронизировать склады из Ozon
 */
exports.syncWarehouses = async (req, res, next) => {
  try {
    const warehouses = await OzonService.fetchWarehouses();
    await Warehouse.syncAll(warehouses);
    res.json({ message: 'Warehouses synced', count: warehouses.length });
  } catch (err) {
    next(err);
  }
};

/**
 * Получить заказы в статусе awaiting_packaging (из Ozon)
 */
exports.getAwaitingOrders = async (req, res, next) => {
  try {
    const { warehouseId } = req.query;
    const allOrders = await OzonService.fetchAwaitingOrders(warehouseId);
    // Получаем все назначенные заказы из БД
    const db = getDB();
    const assigned = await db.all('SELECT order_id FROM assignments WHERE status = "assigned"');
    const assignedSet = new Set(assigned.map(a => a.order_id));
    // Фильтруем только неназначенные
    const freeOrders = allOrders.filter(order => !assignedSet.has(order.posting_number));

    // Для каждого заказа привязываем фото к каждому товару.
    // Фото берутся из in-memory кэша (1 запрос к Ozon на offer_id, дальше из кэша)
    const ordersWithImages = await Promise.all(freeOrders.map(async (order) => {
      const details = await OzonService.getOrderDetails(order.posting_number);
      // Состав берём из деталей (там есть sku) — это гарантирует привязку фото к p.offer_id,
      // запасной вариант — состав из списка заказов
      const sourceProducts = (details && Array.isArray(details.products) && details.products.length)
        ? details.products
        : (order.products || []);
      const products = await OrderService.attachProductImages(sourceProducts);
      return { ...order, products, details };
    }));

    res.json(ordersWithImages);
  } catch (err) {
    next(err);
  }
};

/**
 * Получить детали заказа
 */
exports.getOrderDetails = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const details = await OzonService.getOrderDetails(orderId);
    if (!details) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(details);
  } catch (err) {
    next(err);
  }
};

/**
 * Назначить заказ сотруднику
 */
exports.assignOrder = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    await OrderService.assignOrder(orderId, userId, req.user.id);
    res.json({ message: 'Order assigned successfully' });
  } catch (err) {
    console.error('[assignOrder] Ошибка:', err);
    // Возвращаем 400 для бизнес-ошибок, 500 для остальных
    if (err.message && (
      err.message.includes('не найден') ||
      err.message.includes('уволен') ||
      err.message.includes('Создателю') ||
      err.message.includes('уже обрабатывается') ||
      err.message.includes('не удалось получить')
    )) {
      return res.status(400).json({ error: err.message });
    }
    // Если ошибка связана с Ozon, тоже возвращаем 400
    if (err.message && err.message.includes('Ozon')) {
      return res.status(400).json({ error: err.message });
    }
    next(err); // другие ошибки пойдут в общий обработчик (500)
  }
};

/**
 * Снять заказ с сотрудника
 */
exports.unassignOrder = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    await OrderService.unassignOrder(orderId, req.user.id);
    res.json({ message: 'Order unassigned successfully' });
  } catch (err) {
    console.error('[unassignOrder] Ошибка:', err);
    if (err.message && err.message.includes('не назначен')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * Получить ВСЕ активные заказы (для админа): сотрудник, склад, состав и фото
 */
exports.getActiveOrdersAll = async (req, res, next) => {
  try {
    const active = await Assignment.getAllActive();
    const result = [];
    for (const a of active) {
      // Детали заказа из Ozon (состав, склад)
      const details = await OzonService.getOrderDetails(a.order_id);
      // Статус статистики по всем товарам заказа
      let statsStatus = 'filled';
      const missingStats = [];
      if (details && details.products) {
        for (const p of details.products) {
          if (!p.offer_id) continue;
          const stat = await ProductStat.get(p.offer_id);
          if (!stat) {
            statsStatus = 'missing';
            missingStats.push(p.offer_id);
          }
        }
      }
      // Фото по каждому товару (через кэш — фото грузятся с Ozon 1 раз на offer_id)
      const products = await OrderService.attachProductImages(details?.products || []);
      result.push({
        orderId: a.order_id,
        userId: a.user_id,
        userName: a.user_name,
        assignedAt: a.assigned_at,
        warehouseName: details?.analytics_data?.warehouse || null,
        warehouseId: details?.delivery_method?.warehouse_id || details?.warehouse_id || null,
        statsStatus,
        missingStats,
        products,
      });
    }
    res.json(result);
  } catch (err) {
    console.error('[getActiveOrdersAll] Ошибка:', err);
    next(err);
  }
};

/**
 * Получить активные заказы сотрудника
 */
exports.getUserOrders = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const orders = await Assignment.getActiveOrders(userId);
    res.json(orders);
  } catch (err) {
    next(err);
  }
};

/**
 * Получить статистику сотрудника
 */
exports.getUserStats = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const stats = await UserStats.getStats(userId);
    res.json(stats);
  } catch (err) {
    next(err);
  }
};

/**
 * Экспорт заработка за месяц (Excel)
 */
exports.exportMonthlyEarnings = async (req, res, next) => {
  try {
    const { month } = req.query;
    // Валидация формата month
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Неверный формат месяца. Используйте YYYY-MM' });
    }
    const filePath = await EarningsService.exportMonthlyEarnings(month);
    res.download(filePath);
  } catch (err) {
    console.error('[exportMonthlyEarnings] Ошибка:', err);
    if (err.message && err.message.includes('Нет данных')) {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * Экспорт статистики товаров (материал/цвет/вес) в Excel
 */
exports.exportProductStats = async (req, res, next) => {
  try {
    const filePath = await ProductStatsService.exportProductStatsXlsx();
    // product-stats-1.xlsx | product-stats.xlsx
    res.download(filePath, getVersionedFileName('product-stats', 'xlsx'));
  } catch (err) {
    console.error('[exportProductStats] Ошибка:', err);
    if (err.message && err.message.includes('Нет данных')) {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * Скачать копию файла базы данных (только админ).
 * Используется VACUUM INTO — консистентный снимок БД на момент запроса.
 */
exports.downloadDatabase = async (req, res, next) => {
  try {
    const db = getDB();
    const outputDir = path.join(__dirname, '../../outputs');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const backupPath = path.join(outputDir, `db_backup_${Date.now()}.db`);
    // VACUUM INTO требует литерал пути в SQL — экранируем слэши и кавычки
    const sqlPath = backupPath.replace(/\\/g, '/').replace(/'/g, "''");
    await db.exec(`VACUUM INTO '${sqlPath}'`);
    // bot_web-1.db | bot_web.db (базовое имя берётся из DB_PATH)
    res.download(backupPath, getVersionedFileName(getDbBaseName(), 'db'), (downloadErr) => {
      // Временный снимок больше не нужен
      fs.unlink(backupPath, () => { });
      if (downloadErr) {
        console.error('[downloadDatabase] Ошибка отправки файла:', downloadErr);
      }
    });
  } catch (err) {
    console.error('[downloadDatabase] Ошибка:', err);
    next(err);
  }
};

/**
 * Создать бэкап базы данных вручную (команда администратора).
 * Файл сохраняется в папку backend/backups с датой-временем в имени.
 */
exports.createBackup = async (req, res, next) => {
  try {
    const backupPath = await BackupService.createDbBackup({ includeTime: true });
    if (!backupPath) {
      return res.status(500).json({ error: 'Не удалось создать бэкап (файл БД не найден)' });
    }
    res.json({ message: 'Бэкап создан', file: path.basename(backupPath) });
  } catch (err) {
    console.error('[createBackup] Ошибка:', err);
    next(err);
  }
};

// ============================================================================
// --- АДМИНСКИЕ ИНСТРУМЕНТЫ (аналоги команд бота) ---
// ============================================================================

/**
 * Статус планировщика авто-проверки очереди заказов
 */
exports.getSchedulerStatus = async (req, res) => {
  res.json({ paused: scheduler.isCheckerPaused() });
};

/**
 * Приостановить авто-проверку очереди заказов (аналог /pause из бота)
 */
exports.pauseScheduler = async (req, res) => {
  const wasPaused = scheduler.isCheckerPaused();
  scheduler.pauseChecker();
  console.log(`[ADMIN] ${req.user?.name || req.user?.id} приостановил авто-проверку очереди (/pause)`);
  res.json({
    paused: true,
    message: wasPaused
      ? 'Авто-проверка уже была приостановлена'
      : 'Автоматическая проверка заказов приостановлена',
  });
};

/**
 * Возобновить авто-проверку очереди заказов (аналог /resume из бота)
 */
exports.resumeScheduler = async (req, res) => {
  const wasPaused = scheduler.isCheckerPaused();
  scheduler.resumeChecker();
  console.log(`[ADMIN] ${req.user?.name || req.user?.id} возобновил авто-проверку очереди (/resume)`);
  res.json({
    paused: false,
    message: wasPaused
      ? 'Автоматическая проверка заказов возобновлена'
      : 'Авто-проверка уже работает',
  });
};

/**
 * Удалить статистику товара (аналог /clear_product_stats <offer_id> из бота)
 */
exports.deleteProductStats = async (req, res, next) => {
  try {
    const { offerId } = req.params;
    const existing = await ProductStat.get(offerId);
    if (!existing) {
      return res.status(404).json({ error: `Статистика для ${offerId} не найдена` });
    }
    await ProductStat.delete(offerId);
    console.log(`[ADMIN] ${req.user?.name || req.user?.id} удалил статистику товара ${offerId} (/clear_product_stats)`);
    res.json({ message: `Статистика для ${offerId} удалена` });
  } catch (err) {
    console.error('[deleteProductStats] Ошибка:', err);
    next(err);
  }
};

/**
 * Скачать текущий materials-prices.json
 */
exports.downloadMaterials = async (req, res, next) => {
  try {
    // materials-prices-1.json | materials-prices.json
    res.download(MaterialsService.getFilePath(), getVersionedFileName('materials-prices', 'json'));
  } catch (err) {
    console.error('[downloadMaterials] Ошибка:', err);
    next(err);
  }
};

/**
 * Получить активный заработок всех сотрудников
 */
exports.getActiveEarningsAll = async (req, res, next) => {
  try {
    const users = await User.getAll({ includeAll: true, includeFired: false });
    const result = [];
    for (const user of users) {
      // Только для сотрудников (role не 'user'); Создатель ('god') в списке
      // заработков не участвует — он не обрабатывает заказы
      if (user.role === 'user' || user.role === 'god') continue;
      const base = await Earnings.getActiveSum(user.id, 0, Date.now());
      const adjustments = await Earnings.getActiveAdjustmentsSum(user.id, 0, Date.now());
      const total = base + adjustments;
      result.push({
        ...user,
        activeEarningsBase: base,
        activeEarningsAdjustments: adjustments,
        activeEarningsTotal: total,
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Добавить корректировку заработка
 */
exports.addEarningsAdjustment = async (req, res, next) => {
  try {
    const { userId, amount, reason } = req.body;
    if (!userId || amount === undefined) {
      return res.status(400).json({ error: 'userId and amount are required' });
    }
    // ВАЖНО: используем сервис (а не методы модели напрямую) —
    // именно EarningsService.addAdjustment сохраняет обе записи
    // и отправляет оповещение сотруднику в notifications.db + WebSocket
    await EarningsService.addAdjustment(
      userId,
      amount,
      reason || '',
      req.user?.name || null,
    );
    res.json({ message: 'Adjustment added successfully' });
  } catch (err) {
    next(err);
  }
};

/**
 * Обнулить активный заработок сотрудника (расчёт)
 */
exports.settleEarnings = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    // Сервис очищает активные записи и уведомляет сотрудника об расчёте
    const { clearedAmount } = await EarningsService.settleEmployee(
      userId,
      req.user?.name || null,
    );
    res.json({ message: 'Settled', clearedAmount });
  } catch (err) {
    next(err);
  }
};

/**
 * Сбросить все заработки (только админ)
 */
exports.resetAllEarnings = async (req, res, next) => {
  try {
    const db = require('../config/database').getDB();
    await db.run('BEGIN TRANSACTION');
    await db.run('DELETE FROM earnings_history');
    await db.run('DELETE FROM earnings_active');
    await db.run('DELETE FROM earnings_adjustments');
    await db.run('DELETE FROM earnings_adjustments_active');
    await db.run('COMMIT');
    res.json({ message: 'All earnings data cleared' });
  } catch (err) {
    await db.run('ROLLBACK');
    next(err);
  }
};

/**
 * Сбросить все активные назначения (аналог /clear_assignments из бота).
 * Удаляем все записи со статусом "assigned" и чистим in-memory состояния
 * заказов (формы статистики, подтверждения завершения, флаги завершения) —
 * как это делает confirm_clear_all в bot-версии.
 */
exports.clearAssignments = async (req, res, next) => {
  try {
    const db = require('../config/database').getDB();
    await db.run('DELETE FROM assignments WHERE status = "assigned"');

    // Чистим in-memory состояния (аналог clearOrderState из бота) для всех
    // заказов, у которых были активные формы/подтверждения.
    const {
      pendingForms,
      pendingFinishConfirmations,
      finishingOrders,
    } = require('../state');
    pendingForms.clear();
    pendingFinishConfirmations.clear();
    finishingOrders.clear();

    res.json({ message: 'All assignments cleared' });
  } catch (err) {
    next(err);
  }
};

/**
 * Принудительная перезагрузка очереди заказов из Ozon
 */
exports.reloadQueue = async (req, res, next) => {
  try {
    await OrderService.reloadQueue();
    res.json({ message: 'Queue reloaded' });
  } catch (err) {
    next(err);
  }
};

/**
 * Загрузка файла материалов (materials-prices.json)
 */
exports.uploadMaterials = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    // Строгая проверка имени файла: настройки всегда пишутся в актуальный
    // версионированный файл, поэтому чужое имя — вероятная ошибка конфигурации
    const expectedName = MaterialsService.getFileName();
    if (req.file.originalname !== expectedName) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        // временный файл multer не критичен
      }
      return res.status(400).json({
        error: `Неверное имя файла: "${req.file.originalname}". Ожидается "${expectedName}" (актуальная версия настроек)`,
      });
    }
    const filePath = req.file.path;
    let data;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(content);
    } catch (parseErr) {
      return res.status(400).json({ error: 'Invalid JSON file' });
    }
    if (!data.materials || typeof data.materials !== 'object') {
      throw new Error('Invalid materials format');
    }
    // Сохраняем в постоянный файл
    MaterialsService.updateMaterials(data);
    fs.unlinkSync(filePath);
    res.json({ message: 'Materials updated successfully' });
  } catch (err) {
    console.error('[uploadMaterials] Ошибка:', err);
    if (err.message && err.message.includes('Invalid')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * Скачать актуальный файл материалов (materials-prices.json)
 */
exports.getMaterials = async (req, res, next) => {
  try {
    const data = {
      materials: MaterialsService.getMaterials(),
      specialOffers: MaterialsService.getSpecialOffers(),
      minEarnings: MaterialsService.getMinEarnings(),
      colors: MaterialsService.getColors(),
      // Каноничное имя файла с учётом BOT_VERSION — для строгой
      // проверки имени при загрузке и подписей на кнопках клиента
      fileName: MaterialsService.getFileName(),
    };
    res.json(data);
  } catch (err) {
    console.error('[getMaterials] Ошибка:', err);
    next(err);
  }
};

/**
 * Проверить, что заказ в статусе awaiting_deliver (этикетка доступна).
 * Паритет с ботом (/admin_send_label). Возвращает детали или кидает ошибку
 * со свойством statusCode — готовым HTTP-кодом для клиента.
 */
async function ensureLabelAvailable(orderId) {
  const details = await OzonService.getOrderDetails(orderId);
  if (!details) {
    const err = new Error(`Не удалось получить заказ ${orderId}`);
    err.statusCode = 404;
    throw err;
  }
  if (details.status !== 'awaiting_deliver') {
    const err = new Error(
      `Заказ ${orderId} не в статусе "awaiting_deliver" (текущий: ${details.status}). Этикетка недоступна.`
    );
    err.statusCode = 400;
    throw err;
  }
  return details;
}

/**
 * Скачать этикетку заказа себе (аналог /admin_send_label <номер> без сотрудника).
 * PDF отдаётся в браузер администратора.
 */
exports.downloadOrderLabel = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    await ensureLabelAvailable(orderId);
    const labelBuffer = await OzonService.getPackageLabel(orderId);
    if (!labelBuffer) {
      return res.status(404).json({ error: `Не удалось получить этикетку для заказа ${orderId}` });
    }
    console.log(`[ADMIN] ${req.user?.name || req.user?.id} скачал этикетку заказа ${orderId} себе (/admin_send_label)`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=label_${orderId}.pdf`);
    res.send(labelBuffer);
  } catch (err) {
    console.error('[downloadOrderLabel] Ошибка:', err);
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * Отправить PDF-этикетку заказа сотруднику (аналог /admin_send_label <номер> <id>).
 * Сотрудник выбирается по имени на клиенте -> userId. Этикетка сохраняется
 * на сервере (outputs/labels/<orderId>.pdf), сотруднику уходит оповещение
 * с кнопкой скачивания (GET /user/labels/:orderId/sent).
 */
exports.sendOrderLabelToEmployee = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'Выберите сотрудника' });
    }
    const employee = await User.getById(parseInt(userId, 10));
    if (!employee) {
      return res.status(404).json({ error: 'Сотрудник не найден' });
    }
    if (employee.is_fired) {
      return res.status(400).json({ error: `Сотрудник ${employee.name} уволен` });
    }

    await ensureLabelAvailable(orderId);
    const labelBuffer = await OzonService.getPackageLabel(orderId);
    if (!labelBuffer) {
      return res.status(404).json({ error: `Не удалось получить этикетку для заказа ${orderId}` });
    }

    // Сохраняем PDF на сервере — сотрудник скачает его через /user/labels/:orderId/sent.
    // Имя файла строго из номера заказа (защита от path traversal).
    const safeOrderId = String(orderId).replace(/[^\w.-]/g, '_');
    const labelsDir = path.join(__dirname, '../../outputs', 'labels');
    fs.mkdirSync(labelsDir, { recursive: true });
    fs.writeFileSync(path.join(labelsDir, `${safeOrderId}.pdf`), labelBuffer);

    await NotificationService.notifyUser(employee.id, 'label_sent', {
      orderId,
      adminName: req.user?.name || 'Администратор',
      userName: employee.name,
    });

    console.log(
      `[ADMIN] ${req.user?.name || req.user?.id} отправил этикетку заказа ${orderId} сотруднику ${employee.name} (/admin_send_label)`
    );
    res.json({
      message: `Этикетка заказа ${orderId} отправлена сотруднику ${employee.name}`,
    });
  } catch (err) {
    console.error('[sendOrderLabelToEmployee] Ошибка:', err);
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
};
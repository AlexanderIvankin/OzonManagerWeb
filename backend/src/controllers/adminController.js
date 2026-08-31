const fs = require('fs');
const path = require('path');
const { User, Assignment, UserStats, Earnings, Warehouse, ProductStat } = require('../models');
const SyncService = require('../services/SyncService');
const OzonService = require('../services/OzonService');
const OrderService = require('../services/OrderService');
const EarningsService = require('../services/EarningsService');
const MaterialsService = require('../services/MaterialsService');
const { getLocalTimestamp } = require('../utils');

/**
 * Получить список всех пользователей (с фильтрацией)
 */
exports.getUsers = async (req, res, next) => {
  try {
    const { includeFired, includeAll, role } = req.query;
    const users = await User.getAll({
      includeFired: includeFired === 'true',
      includeAll: includeAll === 'true',
      role
    });
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
    const user = await User.update(userId, { is_fired: 1 });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Снять все активные назначения
    const db = require('../config/database').getDB();
    await db.run('DELETE FROM assignments WHERE user_id = ? AND status = "assigned"', userId);
    res.json({ message: 'User fired successfully' });
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
    const orders = await OzonService.fetchAwaitingOrders(warehouseId);
    res.json(orders);
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
 * Добавить корректировку заработка
 */
exports.addEarningsAdjustment = async (req, res, next) => {
  try {
    const { userId, amount, reason } = req.body;
    if (!userId || amount === undefined) {
      return res.status(400).json({ error: 'userId and amount are required' });
    }
    await Earnings.addAdjustment(userId, amount, reason || '');
    await Earnings.addActiveAdjustment(userId, amount, reason || '');
    // Уведомление пользователю (можно добавить позже через WebSocket)
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
    // Получаем сумму активного заработка (для лога)
    const totalActive = await Earnings.getActiveSum(userId, 0, Date.now());
    // Очищаем активные записи
    await Earnings.clearActive(userId);
    await Earnings.clearActiveAdjustments(userId);
    res.json({ message: 'Settled', clearedAmount: totalActive });
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
 * Сбросить все активные назначения
 */
exports.clearAssignments = async (req, res, next) => {
  try {
    const db = require('../config/database').getDB();
    await db.run('DELETE FROM assignments WHERE status = "assigned"');
    // Также нужно очистить состояния заказов в памяти (позже добавим)
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
    const filePath = req.file.path;
    let data;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(content);
    } catch (parseErr) {
      return res.status(400).json({ error: 'Invalid JSON file' });
    }
    // Сохраняем через сервис
    MaterialsService.updateMaterials(data, filePath);
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
    };
    res.json(data);
  } catch (err) {
    console.error('[getMaterials] Ошибка:', err);
    next(err);
  }
};
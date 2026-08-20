// src/controllers/userController.js
const { Assignment, UserStats, Earnings, ProductStat } = require('../models');
const OrderService = require('../services/OrderService');
const OzonService = require('../services/OzonService');
const { escapeHtml } = require('../utils');

/**
 * Получить профиль текущего пользователя
 */
exports.getProfile = async (req, res) => {
  // req.user уже установлен в middleware authenticate
  // Добавим статистику и активные заказы
  const userId = req.user.id;
  const stats = await UserStats.getStats(userId);
  const activeOrders = await Assignment.getActiveOrders(userId);
  const completedOrders = await Assignment.getCompletedOrders(userId);
  res.json({
    ...req.user,
    stats,
    activeOrders,
    completedOrders,
  });
};

/**
 * Получить активные заказы пользователя с деталями (состав, статус статистики)
 */
exports.getActiveOrders = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const orders = await Assignment.getActiveOrders(userId);
    const result = [];
    for (const order of orders) {
      // Получаем детали из Ozon (можно закешировать)
      const details = await OzonService.getOrderDetails(order.order_id);
      // Проверяем наличие статистики для всех товаров
      let statsStatus = 'filled';
      let missingStats = [];
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
      result.push({
        orderId: order.order_id,
        assignedAt: order.assigned_at,
        statsStatus,
        missingStats,
        products: details?.products || [],
        // другие поля при необходимости
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Завершить заказ (требуется, чтобы все товары имели статистику)
 */
exports.finishOrder = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    const result = await OrderService.finishOrder(orderId, userId);
    res.json({ message: 'Order finished', earnings: result.earnings, label: result.labelBuffer ? 'label available' : 'no label' });
  } catch (err) {
    next(err);
  }
};

/**
 * Отменить заказ (с подтверждением на фронтенде)
 */
exports.cancelOrder = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    await OrderService.cancelOrder(orderId, userId);
    res.json({ message: 'Order cancelled' });
  } catch (err) {
    next(err);
  }
};

/**
 * Получить этикетку для завершённого заказа
 */
exports.getLabel = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    const labelBuffer = await OrderService.getLabel(orderId, userId);
    if (!labelBuffer) {
      return res.status(404).json({ error: 'Label not available' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=label_${orderId}.pdf`);
    res.send(labelBuffer);
  } catch (err) {
    next(err);
  }
};

/**
 * Получить все этикетки для завершённых заказов (объединённые в PDF)
 */
exports.getAllLabels = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const pdfBuffer = await OrderService.getAllLabels(userId);
    if (!pdfBuffer) {
      return res.status(404).json({ error: 'No labels available' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=all_labels.pdf');
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
};

/**
 * Получить заработок за месяц (история)
 */
exports.getMonthlyEarnings = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { month } = req.query; // YYYY-MM
    let fromDate, toDate;
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM' });
      }
      const [year, m] = month.split('-').map(Number);
      fromDate = new Date(year, m - 1, 1).getTime();
      toDate = new Date(year, m, 1).getTime() - 1;
    } else {
      const now = new Date();
      const year = now.getFullYear();
      const m = now.getMonth();
      fromDate = new Date(year, m, 1).getTime();
      toDate = new Date(year, m + 1, 1).getTime() - 1;
    }
    const history = await Earnings.getHistory(userId, fromDate, toDate);
    const total = history.reduce((sum, h) => sum + h.amount, 0);
    res.json({
      period: { from: fromDate, to: toDate },
      earnings: history,
      total,
      count: history.length,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Получить активный заработок (с последнего расчёта)
 */
exports.getActiveEarnings = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const active = await Earnings.getActive(userId, 0, Date.now());
    const totalBase = active.reduce((sum, a) => sum + a.amount, 0);
    const adjustments = await Earnings.getActiveAdjustmentsSum(userId, 0, Date.now());
    const totalWithAdjustments = totalBase + adjustments;
    res.json({
      baseEarnings: totalBase,
      adjustments,
      total: totalWithAdjustments,
      orders: active,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Переключить статус приёма заказов
 */
exports.toggleOrders = async (req, res, next) => {
  try {
    const userId = req.user.id;
    // Получаем текущий статус
    const user = await User.getById(userId);
    const newStatus = user.taking_orders === 1 ? 0 : 1;
    await User.update(userId, { taking_orders: newStatus });
    res.json({ taking_orders: newStatus });
  } catch (err) {
    next(err);
  }
};

/**
 * Заполнить статистику товара (материал, цвет, вес)
 */
exports.fillStats = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { offerId, material, color, weight } = req.body;
    if (!offerId || !material || !color || !weight) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    if (weight <= 0) {
      return res.status(400).json({ error: 'Weight must be positive' });
    }
    await ProductStat.upsert(offerId, material, color, weight, userId);
    res.json({ message: 'Stats saved' });
  } catch (err) {
    next(err);
  }
};

/**
 * Получить список товаров без статистики для текущего пользователя (проверка)
 */
exports.getMissingStats = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const activeOrders = await Assignment.getActiveOrders(userId);
    const missingOffers = new Set();
    for (const order of activeOrders) {
      const details = await OzonService.getOrderDetails(order.order_id);
      if (details && details.products) {
        for (const p of details.products) {
          if (!p.offer_id) continue;
          const stat = await ProductStat.get(p.offer_id);
          if (!stat) {
            missingOffers.add(p.offer_id);
          }
        }
      }
    }
    res.json({ missingOffers: Array.from(missingOffers) });
  } catch (err) {
    next(err);
  }
};
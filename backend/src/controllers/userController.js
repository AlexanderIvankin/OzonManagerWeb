const OrderService = require('../services/OrderService');
const Earnings = require('../models/Earnings');

/**
 * Получить активные заказы пользователя
 */
exports.getActiveOrders = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const orders = await OrderService.getActiveOrders(userId);
    res.json({ orders });
  } catch (err) {
    next(err);
  }
};

/**
 * Завершить заказ
 */
exports.finishOrder = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    const result = await OrderService.finishOrder(orderId, userId);
    // Если есть этикетка – отправляем как файл
    if (result.label) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=label_${orderId}.pdf`);
      return res.send(result.label);
    }
    res.json({ success: true, orderId });
  } catch (err) {
    next(err);
  }
};

/**
 * Отменить заказ
 */
exports.cancelOrder = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    await OrderService.cancelOrder(orderId, userId);
    res.json({ success: true, orderId });
  } catch (err) {
    next(err);
  }
};

/**
 * Получить этикетку завершённого заказа
 */
exports.getLabel = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    const label = await OrderService.getLabel(orderId, userId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=label_${orderId}.pdf`);
    res.send(label);
  } catch (err) {
    next(err);
  }
};

/**
 * Переключить статус приёма заказов
 */
exports.toggleTakingOrders = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const newStatus = await OrderService.toggleTakingOrders(userId);
    res.json({ taking_orders: newStatus });
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
    let { month } = req.query; // YYYY-MM
    let fromDate, toDate;
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'Неверный формат. Используйте YYYY-MM' });
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

    const earnings = await Earnings.getHistory(userId, fromDate, toDate);
    const total = earnings.reduce((sum, e) => sum + e.amount, 0);
    res.json({
      month: month || `${new Date(fromDate).toISOString().slice(0, 7)}`,
      orders: earnings,
      total,
      count: earnings.length,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Получить активный заработок (с момента последнего расчёта)
 */
exports.getActiveEarnings = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const earnings = await Earnings.getActive(userId, 0, Date.now());
    const adjustments = await Earnings.getActiveAdjustmentsSum(userId, 0, Date.now());
    const totalBase = earnings.reduce((sum, e) => sum + e.amount, 0);
    const totalWithAdjustments = totalBase + adjustments;

    res.json({
      base: totalBase,
      adjustments,
      total: totalWithAdjustments,
      orders: earnings,
      count: earnings.length,
    });
  } catch (err) {
    next(err);
  }
};
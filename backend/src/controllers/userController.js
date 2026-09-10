const { Assignment, UserStats, Earnings, ProductStat, User } = require('../models');
const Notification = require('../models/Notification');
const OrderService = require('../services/OrderService');
const OzonService = require('../services/OzonService');
const NotificationService = require('../services/NotificationService');
const { getLocalDate } = require('../utils');
const fs = require('fs');
const path = require('path');

// Строгое ограничение веса пластика в граммах (10 кг) — как в бот-версии
const MAX_WEIGHT_GRAMS = 10000;

/**
 * Получить профиль текущего пользователя
 */
exports.getProfile = async (req, res) => {
  try {
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
  } catch (err) {
    console.error('[getProfile] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
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
      // Привязываем фото к каждому товару (через кэш — фото грузятся с Ozon 1 раз на offer_id)
      const products = await OrderService.attachProductImages(details?.products || []);
      result.push({
        orderId: order.order_id,
        assignedAt: order.assigned_at,
        statsStatus,
        missingStats,
        products,
      });
    }
    res.json(result);
  } catch (err) {
    console.error('[getActiveOrders] Ошибка:', err);
    res.status(500).json({ error: err.message });
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
    res.json({ message: 'Order finished', earnings: result.earnings, label: result.labelAvailable ? 'label available' : 'no label' });
  } catch (err) {
    console.error('[finishOrder] Ошибка:', err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Отменить заказ (с подтверждением на фронтенде)
 */
exports.cancelOrder = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    const result = await OrderService.cancelOrder(orderId, userId);
    res.json({ message: 'Order cancelled' });
  } catch (err) {
    console.error('[cancelOrder] Ошибка:', err);
    res.status(400).json({ error: err.message });
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
    console.error('[getLabel] Ошибка:', err);
    res.status(400).json({ error: err.message });
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
    console.error('[getAllLabels] Ошибка:', err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Скачать этикетку, отправленную сотруднику администратором
 * (аналог получения PDF из /admin_send_label в боте).
 * Доступ: только если сотруднику отправляли оповещение label_sent
 * с этим номером заказа. Файл лежит в outputs/labels/<orderId>.pdf.
 */
exports.getSentLabel = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    // Строгая проверка номера заказа — защита от path traversal
    if (!/^[\w-]+$/.test(orderId)) {
      return res.status(400).json({ error: 'Некорректный номер заказа' });
    }
    const notification = await Notification.findLatestByTypeAndOrder(
      userId,
      'label_sent',
      orderId
    );
    if (!notification) {
      return res.status(403).json({ error: 'Этикетка этого заказа не отправлялась вам' });
    }
    const filePath = path.join(__dirname, '../../outputs', 'labels', `${orderId}.pdf`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: 'Файл этикетки не найден на сервере. Попросите администратора отправить её заново.',
      });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=label_${orderId}.pdf`);
    res.send(fs.readFileSync(filePath));
  } catch (err) {
    console.error('[getSentLabel] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Получить заработок за месяц (история)
 */
exports.getMonthlyEarnings = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { month } = req.query;
    let fromDate, toDate;
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM' });
      }
      const [year, m] = month.split('-').map(Number);
      fromDate = new Date(year, m - 1, 1).getTime();
      toDate = new Date(year, m, 1).getTime() - 1;
    } else {
      // Текущий месяц по локальному времени (TIMEZONE), как в планировщике
      const now = getLocalDate();
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
    console.error('[getMonthlyEarnings] Ошибка:', err);
    res.status(500).json({ error: err.message });
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
    console.error('[getActiveEarnings] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Переключить статус приёма заказов
 */
exports.toggleOrders = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.getById(userId);
    if (!user) throw new Error('User not found');
    const newStatus = user.taking_orders === 1 ? 0 : 1;
    await User.update(userId, { taking_orders: newStatus });

    // Оповещение персоналу: сотрудник изменил приём заказов
    NotificationService.notifyStaff('taking_orders_changed', {
      userId,
      userName: user.name,
      takingOrders: newStatus === 1,
    });

    res.json({ taking_orders: newStatus });
  } catch (err) {
    console.error('[toggleOrders] Ошибка:', err);
    res.status(500).json({ error: err.message });
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
    // Валидация веса (паритет с фронтом): поддерживаем оба разделителя
    // ("12.5" и "12,5"), строгий формат — максимум одна цифра после
    // разделителя, положительное число в пределах MAX_WEIGHT_GRAMS
    const weightNormalized = String(weight).trim().replace(',', '.');
    const weightNum = Number(weightNormalized);
    if (!Number.isFinite(weightNum) || weightNum <= 0) {
      return res.status(400).json({ error: 'Вес должен быть положительным числом (например, 12.5)' });
    }
    if (!/^\d+(\.\d)?$/.test(weightNormalized)) {
      return res.status(400).json({ error: 'Вес указывается с точностью до 0.1 г (одна цифра после запятой)' });
    }
    if (weightNum > MAX_WEIGHT_GRAMS) {
      return res.status(400).json({ error: `Вес не может быть больше ${MAX_WEIGHT_GRAMS} г (10 кг)` });
    }
    await ProductStat.upsert(offerId, material, color, weightNum, userId);

    // Оповещение персоналу: сотрудник заполнил статистику товара
    NotificationService.notifyStaff('stats_filled', {
      userId,
      userName: req.user.name,
      offerId,
      material,
      color,
      weight: weightNum,
    });

    res.json({ message: 'Stats saved' });
  } catch (err) {
    console.error('[fillStats] Ошибка:', err);
    res.status(500).json({ error: err.message });
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
    console.error('[getMissingStats] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};
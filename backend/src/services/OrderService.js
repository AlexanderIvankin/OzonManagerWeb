const OzonService = require('./OzonService');
const Assignment = require('../models/Assignment');
const UserStats = require('../models/UserStats');
const Earnings = require('../models/Earnings');
const ProductStat = require('../models/ProductStat');
const User = require('../models/User');
const config = require('../config');

// Коэффициенты для расчёта заработка (можно вынести в конфиг или БД)
const MATERIALS_PRICES = {
  'Pet-G': 2.5,
  'ABS': 2.5,
  'Нейлон Pa-6': 2.5,
  'Нейлон Pa-12': 2.5,
  'НейлонАрмир': 2.5,
  'ASA': 2.5,
};
const MIN_EARNINGS_PER_UNIT = 250; // минимальный заработок за единицу товара

class OrderService {
  /**
   * Получить активные заказы пользователя с деталями
   */
  static async getActiveOrders(userId) {
    const assignments = await Assignment.getActiveOrders(userId);
    if (!assignments.length) return [];

    const ordersWithDetails = [];
    for (const assign of assignments) {
      const orderId = assign.order_id;
      // Получаем детали из Ozon
      let details = null;
      try {
        details = await OzonService.getOrderDetails(orderId);
      } catch (err) {
        console.error(`[OrderService] Ошибка получения деталей заказа ${orderId}:`, err.message);
        // Продолжаем без деталей
      }

      // Проверяем наличие статистики для всех товаров
      let statsStatus = 'filled';
      let missingStats = [];
      if (details && details.products) {
        const offerIds = details.products.map(p => p.offer_id).filter(Boolean);
        if (offerIds.length) {
          const { missing } = await ProductStat.checkBatch(offerIds);
          if (missing.length) {
            statsStatus = 'missing';
            missingStats = missing;
          }
        }
      }

      ordersWithDetails.push({
        orderId,
        assignedAt: assign.assigned_at,
        status: statsStatus,
        missingStats,
        details: details || null,
      });
    }
    return ordersWithDetails;
  }

  /**
   * Завершить заказ (проверка статистики, подтверждение сборки, расчёт заработка)
   */
  static async finishOrder(orderId, userId) {
    // Проверяем, что заказ принадлежит пользователю
    const isAssigned = await Assignment.isAssignedToUser(orderId, userId);
    if (!isAssigned) {
      throw new Error('Заказ не найден или не принадлежит вам');
    }

    // Получаем детали заказа
    const details = await OzonService.getOrderDetails(orderId);
    if (!details) throw new Error('Не удалось получить детали заказа');

    // Проверяем статус заказа (должен быть awaiting_packaging)
    if (details.status !== 'awaiting_packaging') {
      throw new Error(`Заказ не в статусе "awaiting_packaging" (текущий: ${details.status})`);
    }

    // Проверяем наличие статистики для всех товаров
    const offerIds = details.products.map(p => p.offer_id).filter(Boolean);
    if (offerIds.length) {
      const { missing } = await ProductStat.checkBatch(offerIds);
      if (missing.length) {
        throw new Error(`Отсутствует статистика для товаров: ${missing.join(', ')}`);
      }
    }

    // Подтверждаем сборку через Ozon
    try {
      await OzonService.confirmPostingShip(orderId);
    } catch (err) {
      // Если заказ уже подтверждён (статус не awaiting_packaging), пропускаем
      if (!err.message.includes('не в статусе awaiting_packaging')) {
        throw err;
      }
    }

    // Ждём генерации этикетки (Ozon генерирует не сразу)
    await new Promise(resolve => setTimeout(resolve, 15000));

    // Получаем этикетку
    const labelBuffer = await OzonService.getPackageLabel(orderId);

    // Расчёт заработка
    const user = await User.getById(userId);
    if (!user) throw new Error('Пользователь не найден');
    const earningsData = await this.calculateEarnings(details, user);

    // Транзакция БД
    const db = require('../config/database').getDB();
    await db.run('BEGIN TRANSACTION');

    try {
      // Обновляем статистику пользователя (total_orders, total_amount)
      const totalAmount = await OzonService.getOrderTotalAmount(orderId);
      await UserStats.incrementStats(userId, totalAmount);

      // Сохраняем заработок
      if (earningsData && earningsData.total > 0) {
        await Earnings.saveHistory(userId, orderId, earningsData.total);
        await Earnings.saveActive(userId, orderId, earningsData.total);
      }

      // Завершаем заказ в БД
      await Assignment.complete(orderId);

      await db.run('COMMIT');
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }

    // Возвращаем результат
    return {
      success: true,
      label: labelBuffer,
      earnings: earningsData,
      orderId,
    };
  }

  /**
   * Отменить заказ (пользователь)
   */
  static async cancelOrder(orderId, userId) {
    // Проверяем принадлежность
    const isAssigned = await Assignment.isAssignedToUser(orderId, userId);
    if (!isAssigned) {
      throw new Error('Заказ не найден или не принадлежит вам');
    }

    // Отменяем (удаляем назначение)
    await Assignment.cancel(orderId, userId);
    // Увеличиваем счётчик отмен
    await UserStats.incrementCanceled(userId);

    return { success: true, orderId };
  }

  /**
   * Получить этикетку для завершённого заказа (проверяем статус)
   */
  static async getLabel(orderId, userId) {
    // Проверяем, что заказ завершён и принадлежит пользователю
    const assignment = await require('../models/Assignment').getByOrderId(orderId);
    if (!assignment || assignment.user_id !== userId) {
      throw new Error('Заказ не найден');
    }
    if (assignment.status !== 'completed') {
      throw new Error('Заказ ещё не завершён');
    }

    // Проверяем статус через Ozon (должен быть awaiting_deliver)
    const details = await OzonService.getOrderDetails(orderId);
    if (!details || details.status !== 'awaiting_deliver') {
      throw new Error(`Заказ не в статусе "awaiting_deliver" (текущий: ${details?.status || 'неизвестен'})`);
    }

    // Получаем этикетку
    const label = await OzonService.getPackageLabel(orderId);
    if (!label) {
      throw new Error('Не удалось получить этикетку');
    }
    return label;
  }

  /**
   * Переключить статус приёма заказов
   */
  static async toggleTakingOrders(userId) {
    const user = await User.getById(userId);
    if (!user) throw new Error('Пользователь не найден');
    const newStatus = user.taking_orders === 1 ? 0 : 1;
    await User.update(userId, { taking_orders: newStatus });
    return newStatus;
  }

  /**
   * Вспомогательный метод расчёта заработка (аналог из бота)
   */
  static async calculateEarnings(orderDetails, user) {
    const earningsDetails = [];
    let totalEarnings = 0;
    let allHaveStats = true;
    const factor = user.earnings_factor || 1.0;

    for (const product of orderDetails.products) {
      const offerId = product.offer_id;
      if (!offerId) continue;
      const stats = await ProductStat.get(offerId);
      if (!stats) {
        allHaveStats = false;
        console.warn(`[EARN] Для товара ${offerId} нет статистики`);
        continue;
      }
      const materialPrice = MATERIALS_PRICES[stats.material] || 0;
      const weight = stats.weight_grams || 0;
      let earningsPerUnit = materialPrice * weight;
      if (earningsPerUnit < MIN_EARNINGS_PER_UNIT) earningsPerUnit = MIN_EARNINGS_PER_UNIT;
      earningsPerUnit = earningsPerUnit * factor;

      const quantity = product.quantity || 1;
      const totalForProduct = earningsPerUnit * quantity;
      totalEarnings += totalForProduct;
      earningsDetails.push({
        offerId,
        productName: product.name,
        material: stats.material,
        weight,
        quantity,
        earningsPerUnit,
        totalForProduct,
      });
    }
    return { total: totalEarnings, details: earningsDetails, allHaveStats };
  }
}

module.exports = OrderService;
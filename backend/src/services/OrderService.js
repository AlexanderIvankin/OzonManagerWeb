const OzonService = require('./OzonService');
const Assignment = require('../models/Assignment');
const UserStats = require('../models/UserStats');
const Earnings = require('../models/Earnings');
const ProductStat = require('../models/ProductStat');
const User = require('../models/User');
const { notifyUser, notifyModerators } = require('../socket');
const fs = require('fs');

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

// Очередь заказов в памяти (для веб-версии)
let pendingNewOrders = [];
let currentOrderProcessing = null;

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
 * Завершить заказ (основная логика)
 */
  static async finishOrder(orderId, userId) {
    // Проверяем, что заказ принадлежит пользователю и ещё не завершён
    const assignment = await Assignment.getByOrderId(orderId);
    if (!assignment || assignment.user_id !== userId || assignment.status !== 'assigned') {
      throw new Error('Order not found or not assigned to you');
    }

    // Проверяем наличие статистики для всех товаров
    const details = await OzonService.getOrderDetails(orderId);
    const missingStats = [];
    if (details && details.products) {
      for (const p of details.products) {
        if (!p.offer_id) continue;
        const stat = await ProductStat.get(p.offer_id);
        if (!stat) missingStats.push(p.offer_id);
      }
    }
    if (missingStats.length) {
      throw new Error(`Missing stats for: ${missingStats.join(', ')}`);
    }

    // Получаем пользователя (для коэффициента)
    const user = await User.getById(userId);
    // Материалы загружаем из файла (пока заглушка)
    const materialsData = require('../config/materials').getMaterials(); // создадим позже

    // Расчёт заработка
    const earnings = await EarningsService.calculateOrderEarnings(details, user, materialsData);
    // Если нет статистики для некоторых товаров – ошибка, но мы уже проверили
    if (!earnings.allHaveStats) {
      throw new Error('Not all products have stats'); // на самом деле не должно случиться
    }

    // Подтверждаем сборку через Ozon
    try {
      await OzonService.confirmPostingShip(orderId);
    } catch (err) {
      if (!err.message.includes('не в статусе awaiting_packaging')) throw err;
    }

    // Ждём генерации этикетки
    await new Promise(resolve => setTimeout(resolve, 15000));
    const labelBuffer = await OzonService.getPackageLabel(orderId);

    // Сохраняем в БД (транзакция)
    const db = getDB();
    await db.run('BEGIN');
    try {
      // Обновляем статистику пользователя
      const orderAmount = await OzonService.getOrderTotalAmount(orderId);
      await UserStats.incrementStats(userId, orderAmount);
      // Сохраняем заработок
      if (earnings.total > 0) {
        await Earnings.saveHistory(userId, orderId, earnings.total);
        await Earnings.saveActive(userId, orderId, earnings.total);
      }
      // Завершаем заказ
      await Assignment.complete(orderId);
      await db.run('COMMIT');
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }

    // Отправляем этикетку (через контроллер или возвращаем буфер)
    return { earnings: earnings.total, labelBuffer };
  }

  /**
   * Отменить заказ (пользователь)
   */
  static async cancelOrder(orderId, userId) {
    const assignment = await Assignment.getByOrderId(orderId);
    if (!assignment || assignment.user_id !== userId || assignment.status !== 'assigned') {
      throw new Error('Order not found or not assigned to you');
    }
    // Удаляем назначение
    await Assignment.cancel(orderId, userId);
    // Увеличиваем счётчик отмен
    await UserStats.incrementCanceled(userId);
  }

  /**
   * Получить этикетку для завершённого заказа (проверка прав)
   */
  static async getLabel(orderId, userId) {
    const assignment = await Assignment.getByOrderId(orderId);
    if (!assignment || assignment.user_id !== userId || assignment.status !== 'completed') {
      throw new Error('Order not found or not completed');
    }
    // Проверяем статус в Ozon (должен быть awaiting_deliver)
    const details = await OzonService.getOrderDetails(orderId);
    if (details.status !== 'awaiting_deliver') {
      throw new Error('Label not available yet');
    }
    return await OzonService.getPackageLabel(orderId);
  }

  /**
   * Получить все этикетки для завершённых заказов пользователя
   */
  static async getAllLabels(userId) {
    const completed = await Assignment.getCompletedOrders(userId);
    const labelBuffers = [];
    for (const order of completed) {
      try {
        const label = await OzonService.getPackageLabel(order.order_id);
        if (label) labelBuffers.push(label);
      } catch (err) {
        console.error(`[OrderService] Ошибка получения этикетки для ${order.order_id}:`, err.message);
      }
    }
    if (!labelBuffers.length) return null;
    // Объединяем PDF (нужна функция mergePdfs из utils)
    const { mergePdfs } = require('../utils'); // создадим позже
    return await mergePdfs(labelBuffers);
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

  /**
   * Проверяет новые заказы из Ozon и обновляет очередь
   * (вызывается по расписанию)
   */
  static async checkNewOrders() {
    console.log('[OrderService] Проверка новых заказов...');
    try {
      // 1. Получаем все заказы в статусе awaiting_packaging
      const allOrders = await OzonService.fetchAwaitingOrders();
      if (!allOrders.length) {
        console.log('[OrderService] Нет заказов в awaiting_packaging');
        // Если очередь пуста – сбрасываем текущий заказ
        if (this.pendingOrders.length === 0) {
          this.currentOrder = null;
        }
        return;
      }

      // 2. Получаем уже назначенные заказы (из БД)
      const db = getDB();
      const assignedRows = await db.all('SELECT order_id FROM assignments WHERE status = "assigned"');
      const assignedSet = new Set(assignedRows.map(r => r.order_id));

      // 3. Фильтруем новые заказы (которые ещё не назначены)
      const newOrders = allOrders.filter(order => !assignedSet.has(order.posting_number));

      if (!newOrders.length) {
        console.log('[OrderService] Новых заказов нет');
        return;
      }

      // 4. Обновляем очередь: заменяем на новые заказы (если текущий заказ ещё актуален, он уже в newOrders)
      this.pendingOrders = newOrders;

      // 5. Если нет текущего обрабатываемого заказа и есть заказы – устанавливаем первый
      if (!this.currentOrder && this.pendingOrders.length) {
        this.currentOrder = this.pendingOrders[0];
        // Здесь можно уведомить модераторов через WebSocket о новом заказе
        console.log(`[OrderService] Новый заказ для модерации: ${this.currentOrder.posting_number}`);
        // В будущем: emit('new_order', this.currentOrder)
      }

      console.log(`[OrderService] Очередь обновлена, заказов: ${this.pendingOrders.length}`);
    } catch (err) {
      console.error('[OrderService] Ошибка checkNewOrders:', err);
      throw err;
    }
  }

  /**
   * Получить текущий заказ для модерации (для API)
   */
  static getCurrentOrder() {
    return this.currentOrder;
  }

  /**
   * Получить всю очередь (для API)
   */
  static getPendingOrders() {
    return this.pendingOrders;
  }

  /**
   * Пропустить текущий заказ (вызывается модератором)
   */
  static skipCurrentOrder() {
    if (!this.currentOrder) return;
    // Удаляем текущий заказ из очереди
    this.pendingOrders = this.pendingOrders.filter(o => o.posting_number !== this.currentOrder.posting_number);
    // Устанавливаем следующий, если есть
    this.currentOrder = this.pendingOrders.length ? this.pendingOrders[0] : null;
    console.log('[OrderService] Текущий заказ пропущен');
  }

  /**
   * Назначить заказ (вызывается при назначении)
   * @param {string} orderId - номер заказа
   * @param {number} userId - ID пользователя
   * @param {number} adminId - ID администратора, назначившего
   */
  static async assignOrder(orderId, userId, adminId) {
    // Проверяем, что заказ есть в очереди или актуален
    // Назначаем через Assignment.assign
    // Удаляем из очереди
    await Assignment.assign(orderId, userId);
    // Удаляем из очереди
    this.pendingOrders = this.pendingOrders.filter(o => o.posting_number !== orderId);
    if (this.currentOrder && this.currentOrder.posting_number === orderId) {
      this.currentOrder = this.pendingOrders.length ? this.pendingOrders[0] : null;
    }
    // Логируем
    console.log(`[OrderService] Заказ ${orderId} назначен пользователю ${userId} администратором ${adminId}`);
    notifyUser(userId, 'order_assigned', { orderId, message: 'Вам назначен заказ' });
    notifyModerators('order_assigned', { orderId, userId, message: 'Заказ назначен' });
  }

  /**
   * Снять заказ с сотрудника (админ)
   */
  static async unassignOrder(orderId, adminId) {
    const assignment = await Assignment.getByOrderId(orderId);
    if (!assignment || assignment.status !== 'assigned') {
      throw new Error('Заказ не назначен');
    }
    await Assignment.autoCancel(orderId);
    // Возвращаем заказ в очередь? Но он может уже не быть в awaiting_packaging, поэтому лучше перезагрузить очередь
    await this.checkNewOrders();
    console.log(`[OrderService] Заказ ${orderId} снят администратором ${adminId}`);
  }

  /**
   * Перезагрузить очередь (принудительно)
   */
  static async reloadQueue() {
    this.pendingOrders = [];
    this.currentOrder = null;
    await this.checkNewOrders();
  }

}

module.exports = OrderService;
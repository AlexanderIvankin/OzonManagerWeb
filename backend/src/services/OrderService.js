const OzonService = require('./OzonService');
const { Assignment, UserStats, Earnings, ProductStat, User } = require('../models');
const { getDB } = require('../config/database');
const { notifyUser, notifyModerators } = require('../socket');
const { escapeHtml } = require('../utils');
const { finishingOrders, pendingFinishConfirmations, pendingForms, processingOrders, productImagesCache } = require('../state');
const EarningsService = require('./EarningsService');

// Глобальное состояние очереди (в памяти)
let pendingNewOrders = [];
let currentOrderProcessing = null;
let orderAssignRetries = new Map();

// Конфигурация
const MIN_EARNINGS = 250;
const MATERIALS_PRICES = {
  'Pet-G': 2.5,
  'ABS': 2.5,
  'Нейлон Pa-6': 2.5,
  'Нейлон Pa-12': 2.5,
  'НейлонАрмир': 2.5,
  'ASA': 2.5,
};
let specialOffers = null; // загружается из materials-prices.json

class OrderService {
  // =================================================================
  // 1. ОЧИСТКА УСТАРЕВШИХ НАЗНАЧЕНИЙ (из bot.js)
  // =================================================================
  static async cleanExpiredAssignments(activeOrderIds) {
    console.log('[OrderService] cleanExpiredAssignments начата');
    const activeSet = new Set(activeOrderIds);
    const db = getDB();

    // Получаем все активные назначения с LEFT JOIN на users
    const assignments = await db.all(
      `SELECT a.order_id, a.user_id, u.tg_user_id, u.name as employee_name,
            u.is_fired, a.status as local_status
     FROM assignments a
     LEFT JOIN users u ON a.user_id = u.id
     WHERE a.status = "assigned"`
    );

    for (const assignment of assignments) {
      const orderId = assignment.order_id;

      // === 1. Проверка зависших состояний завершения ===
      const finishState = finishingOrders.get(orderId);
      if (finishState) {
        const elapsed = Date.now() - finishState.startedAt;
        if (elapsed < 10 * 60 * 1000) {
          console.log(`[CLEAN] Заказ ${orderId} в процессе завершения (${Math.round(elapsed / 1000)} сек.), пропускаем`);
          continue;
        }
        console.warn(`[CLEAN] Заказ ${orderId} завис в finishingOrders на ${Math.round(elapsed / 60000)} мин. Принудительно удаляем.`);
        finishingOrders.delete(orderId);
        pendingFinishConfirmations.delete(orderId);
      }

      const confirmState = pendingFinishConfirmations.get(orderId);
      if (confirmState) {
        if (!confirmState.startedAt) {
          console.warn(`[CLEAN] Заказ ${orderId} имеет pendingFinishConfirmations без startedAt. Удаляем.`);
          pendingFinishConfirmations.delete(orderId);
        } else {
          const elapsed = Date.now() - confirmState.startedAt;
          if (elapsed > 10 * 60 * 1000) {
            console.warn(`[CLEAN] Заказ ${orderId} имеет зависшее pendingFinishConfirmations (${Math.round(elapsed / 60000)} мин), удаляем.`);
            pendingFinishConfirmations.delete(orderId);
          } else {
            console.log(`[CLEAN] Заказ ${orderId} ожидает подтверждения, пропускаем`);
            continue;
          }
        }
      }

      // === 2. Если заказ всё ещё в awaiting_packaging — пропускаем ===
      if (activeSet.has(orderId)) {
        continue;
      }

      // === 3. Если заказ уже завершён в БД — пропускаем ===
      if (assignment.local_status === 'completed') {
        console.log(`[CLEAN] Заказ ${orderId} уже завершён (status=completed), пропускаем`);
        continue;
      }

      const freshStatus = await db.get(
        'SELECT status FROM assignments WHERE order_id = ?',
        orderId
      );
      if (freshStatus && freshStatus.status === 'completed') {
        console.log(`[CLEAN] Заказ ${orderId} уже завершён (повторная проверка), пропускаем`);
        continue;
      }

      // === 4. Если сотрудник отсутствует или уволен — снимаем заказ ===
      if (!assignment.employee_name || assignment.is_fired === 1) {
        console.warn(`[CLEAN] Заказ ${orderId} назначен на некорректного сотрудника (user_id=${assignment.user_id}), снимаем`);
        await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
        notifyModerators('order_unassigned', {
          orderId,
          reason: 'Сотрудник отсутствует или уволен',
          employeeName: assignment.employee_name || 'не найден'
        });
        if (assignment.tg_user_id) {
          notifyUser(assignment.tg_user_id, 'order_unassigned', {
            orderId,
            reason: 'Сотрудник отсутствует или уволен'
          });
        }
        continue;
      }

      // === 5. Стандартное удаление: заказ больше не в awaiting_packaging ===
      console.log(`[CLEAN] Заказ ${orderId} больше не в awaiting_packaging, отменяем назначение у ${assignment.employee_name}`);
      await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
      notifyModerators('order_unassigned', {
        orderId,
        reason: 'Заказ более не актуален (не в awaiting_packaging)',
        employeeName: assignment.employee_name
      });
      if (assignment.tg_user_id) {
        notifyUser(assignment.tg_user_id, 'order_unassigned', {
          orderId,
          reason: 'Заказ более не актуален'
        });
      }
    }

    console.log('[OrderService] cleanExpiredAssignments завершена');
  }

  // =================================================================
  // 2. ПРОВЕРКА НОВЫХ ЗАКАЗОВ (из bot.js checkAndOfferNewOrders)
  // =================================================================
  static async checkNewOrders() {
    console.log('[OrderService] Проверка новых заказов...');
    try {
      const allOrders = await OzonService.fetchAwaitingOrders();
      const activeOrderIds = allOrders.map(o => o.posting_number);
      await OrderService.cleanExpiredAssignments(activeOrderIds);

      if (!allOrders.length) {
        if (pendingNewOrders.length === 0) {
          currentOrderProcessing = null;
        }
        return;
      }

      const db = getDB();
      const assignedOrderIds = (await db.all('SELECT order_id FROM assignments WHERE status = "assigned"'))
        .map(r => r.order_id);
      const assignedSet = new Set(assignedOrderIds);

      const newOrders = allOrders.filter(order => !assignedSet.has(order.posting_number));
      if (!newOrders.length) {
        return;
      }

      // Сохраняем текущий обрабатываемый заказ
      const currentOrderId = currentOrderProcessing?.order?.posting_number;
      if (currentOrderId && !newOrders.some(o => o.posting_number === currentOrderId)) {
        console.log(`[CHECK] Текущий заказ ${currentOrderId} больше не в awaiting_packaging, сбрасываем`);
        currentOrderProcessing = null;
      }

      pendingNewOrders = newOrders;
      console.log(`[CHECK] Очередь обновлена, заказов: ${pendingNewOrders.length}`);

      // Уведомляем модераторов о новых заказах (через WebSocket)
      notifyModerators('new_orders_available', {
        count: pendingNewOrders.length,
        orders: pendingNewOrders.map(o => ({
          posting_number: o.posting_number,
          products_count: o.products?.length || 0,
        }))
      });

      // Если нет активного заказа и есть заказы – берём первый
      if (!currentOrderProcessing && pendingNewOrders.length) {
        currentOrderProcessing = { order: pendingNewOrders[0], timestamp: Date.now() };
      }

    } catch (err) {
      console.error('[OrderService] Ошибка checkNewOrders:', err);
      throw err;
    }
  }

  // =================================================================
  // 3. НАЗНАЧЕНИЕ ЗАКАЗА (из commands.js assignOrder)
  // =================================================================
  static async assignOrder(orderId, userId, adminId = null) {
    // Блокировка
    if (processingOrders.has(orderId)) {
      console.log(`[ASSIGN] Заказ ${orderId} уже обрабатывается, пропускаем.`);
      throw new Error('Заказ уже обрабатывается');
    }
    processingOrders.add(orderId);

    let queuedOrder = null;
    const queueIndex = pendingNewOrders.findIndex(o => o.posting_number === orderId);
    if (queueIndex !== -1) {
      queuedOrder = pendingNewOrders.splice(queueIndex, 1)[0];
      console.log(`[ASSIGN] Заказ ${orderId} удалён из очереди`);
    }
    if (currentOrderProcessing?.order?.posting_number === orderId) {
      currentOrderProcessing = null;
    }

    let assignedInDb = false;
    let employee = null;
    let orderDetails = null;

    try {
      // Проверка сотрудника
      employee = await User.getById(userId);
      if (!employee) throw new Error(`Сотрудник с ID ${userId} не найден.`);
      if (employee.is_fired) throw new Error(`Сотрудник ${employee.name} уволен.`);

      // Получение деталей заказа
      orderDetails = await OzonService.getOrderDetails(orderId);
      if (!orderDetails) throw new Error(`Не удалось получить детали заказа ${orderId}.`);

      // Очистка старых состояний
      await this.clearOrderState(orderId);

      // Назначение в БД
      await Assignment.assign(orderId, userId);
      assignedInDb = true;
      console.log(`[ASSIGN] Заказ ${orderId} записан в БД за сотрудником ${employee.name}`);

      // Дальнейшая логика: статистика, фото, модели, формы статистики (опускаем для краткости)
      // Здесь мы отправляем уведомление сотруднику через WebSocket
      notifyUser(userId, 'order_assigned', {
        orderId,
        message: `Вам назначен заказ ${orderId}`,
        details: orderDetails
      });

      notifyModerators('order_assigned', {
        orderId,
        userId,
        employeeName: employee.name,
        message: 'Заказ назначен'
      });

      orderAssignRetries.delete(orderId);
      console.log(`[ASSIGN] Заказ ${orderId} успешно назначен сотруднику ${employee.name} (ID ${employee.id})`);
      return { success: true, employee };

    } catch (err) {
      console.error(`[ASSIGN] Ошибка назначения заказа ${orderId}:`, err);

      if (assignedInDb) {
        // Ошибка после записи в БД — не возвращаем заказ в очередь
        console.error(`[ASSIGN] Заказ ${orderId} уже назначен в БД, в очередь не возвращаем.`);
        notifyModerators('order_assign_error', {
          orderId,
          error: err.message,
          employeeName: employee?.name || userId
        });
      } else {
        // Ошибка до записи в БД — возвращаем заказ в очередь
        let retries = orderAssignRetries.get(orderId) || 0;
        retries++;
        orderAssignRetries.set(orderId, retries);

        if (retries <= 3) {
          if (!pendingNewOrders.some(o => o.posting_number === orderId)) {
            if (!queuedOrder) {
              try {
                queuedOrder = await OzonService.fetchAwaitingOrdersById(orderId);
              } catch (e) {
                queuedOrder = { posting_number: orderId, products: [] };
              }
            }
            if (queuedOrder) {
              pendingNewOrders.unshift(queuedOrder);
              console.log(`[ASSIGN] Заказ ${orderId} возвращён в очередь (попытка ${retries}/3).`);
            }
          }
        } else {
          console.error(`[ASSIGN] Заказ ${orderId} не удалось назначить после 3 попыток.`);
          notifyModerators('order_assign_failed', {
            orderId,
            error: err.message,
            attempts: retries
          });
          orderAssignRetries.delete(orderId);
        }
      }
      throw err;
    } finally {
      processingOrders.delete(orderId);
      console.log(`[ASSIGN] Блокировка для ${orderId} снята.`);
    }
  }

  // =================================================================
  // 4. ЗАВЕРШЕНИЕ ЗАКАЗА (из commands.js finishOrder)
  // =================================================================
  static async finishOrder(orderId, userId) {
    console.log(`[FINISH] === Начало завершения заказа ${orderId} сотрудником ${userId} ===`);
    let transactionCompleted = false;

    try {
      // Проверяем, что заказ ещё активен и принадлежит пользователю
      const db = getDB();
      const assignment = await db.get(
        'SELECT status FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
        orderId, userId
      );
      if (!assignment) {
        throw new Error(`Заказ ${orderId} уже завершён или не найден.`);
      }

      // Получаем пользователя
      const user = await User.getById(userId);
      if (!user) throw new Error('Пользователь не найден');

      // 1. Получаем сумму заказа
      const orderAmount = await OzonService.getOrderTotalAmount(orderId);
      console.log(`[FINISH] Сумма заказа: ${orderAmount}`);

      // 2. Рассчитываем заработок
      const orderDetails = await OzonService.getOrderDetails(orderId);
      let earningsData = null;
      if (orderDetails && orderDetails.products) {
        const materialsData = { materials: MATERIALS_PRICES, minEarnings: MIN_EARNINGS, specialOffers };
        earningsData = await EarningsService.calculateOrderEarnings(orderDetails, user);
        if (!earningsData.allHaveStats) {
          console.warn(`[FINISH] Не все товары имеют статистику для заказа ${orderId}`);
        }
      }

      // 3. Подтверждение сборки через Ozon
      let labelBuffer = null;
      let isAlreadyConfirmed = false;
      try {
        await OzonService.confirmPostingShip(orderId);
      } catch (shipError) {
        if (shipError.message && shipError.message.includes('не в статусе awaiting_packaging')) {
          console.warn(`[FINISH] Заказ ${orderId} уже подтверждён (статус не awaiting_packaging)`);
          isAlreadyConfirmed = true;
        } else {
          throw shipError;
        }
      }

      if (!isAlreadyConfirmed) {
        // Ожидаем 15 секунд для генерации этикетки
        await new Promise(resolve => setTimeout(resolve, 15000));
      }

      labelBuffer = await OzonService.getPackageLabel(orderId);

      // ========== ТРАНЗАКЦИЯ БД ==========
      await db.run('BEGIN TRANSACTION');

      try {
        // Обновляем статистику
        await UserStats.incrementStats(userId, orderAmount);

        // Сохраняем заработок
        if (earningsData && earningsData.total > 0) {
          const existing = await db.get('SELECT id FROM earnings_history WHERE order_id = ?', orderId);
          if (!existing) {
            await Earnings.saveHistory(userId, orderId, earningsData.total);
            await Earnings.saveActive(userId, orderId, earningsData.total);
          }
        }

        // Завершаем заказ
        await Assignment.complete(orderId);

        // Очищаем in-memory кэш фотографий для товаров этого заказа
        // (заказ завершён — фото больше не нужны на страницах активных заказов)
        if (orderDetails && Array.isArray(orderDetails.products)) {
          for (const p of orderDetails.products) {
            if (p.offer_id) productImagesCache.delete(String(p.offer_id));
          }
        }

        await db.run('COMMIT');
        transactionCompleted = true;
        console.log(`[FINISH] Транзакция успешно закоммичена для заказа ${orderId}`);
      } catch (txError) {
        await db.run('ROLLBACK');
        console.error(`[FINISH] Ошибка в транзакции для заказа ${orderId}:`, txError);
        throw txError;
      }

      // Отправляем этикетку (если есть)
      if (labelBuffer) {
        // В веб-версии этикетка будет доступна через API /api/user/orders/:orderId/label
        // Поэтому просто сохраняем в локальном хранилище или возвращаем через WebSocket
        notifyUser(userId, 'order_finished', {
          orderId,
          labelAvailable: true,
          earnings: earningsData?.total || 0
        });
      } else {
        notifyUser(userId, 'order_finished', {
          orderId,
          labelAvailable: false,
          earnings: earningsData?.total || 0
        });
      }

      notifyModerators('order_finished', {
        orderId,
        userId,
        employeeName: user.name,
        earnings: earningsData?.total || 0
      });

      // Очищаем состояния
      await this.clearOrderState(orderId);

      console.log(`[FINISH] === Заказ ${orderId} успешно завершён ===`);
      return { success: true, earnings: earningsData?.total || 0, labelAvailable: !!labelBuffer };

    } catch (err) {
      console.error(`[FINISH] Ошибка при завершении заказа ${orderId}:`, err);
      throw err;
    } finally {
      // Принудительно удаляем флаги
      if (!transactionCompleted) {
        console.log(`[FINISH] Принудительно удаляем флаги для ${orderId}`);
        finishingOrders.delete(orderId);
        pendingFinishConfirmations.delete(orderId);
      }
    }
  }

  // =================================================================
  // 5. ОТМЕНА ЗАКАЗА
  // =================================================================

  // ОТМЕНА ЗАКАЗА (пользователь)
  static async cancelOrder(orderId, userId) {
    console.log(`[CANCEL] Отмена заказа ${orderId} пользователем ${userId}`);
    const db = getDB();

    // Проверяем, что заказ назначен этому пользователю и ещё не завершён
    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
      orderId, userId
    );
    if (!assignment) {
      throw new Error('Заказ не найден или не назначен вам');
    }

    // Удаляем назначение
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);

    // Увеличиваем счётчик отменённых заказов (вина пользователя)
    await UserStats.incrementCanceled(userId);

    // Уведомляем пользователя и модераторов
    notifyUser(userId, 'order_cancelled', { orderId });
    notifyModerators('order_cancelled', { orderId, userId, reason: 'Отменён пользователем' });

    // Возвращаем заказ в очередь (перезагружаем)
    await this.reloadQueue();

    return { success: true };
  }

  // СНЯТИЕ ЗАКАЗА АДМИНИСТРАТОРОМ (без увеличения счётчика отмен)
  static async unassignOrder(orderId, adminId) {
    console.log(`[UNASSIGN] Снятие заказа ${orderId} администратором ${adminId}`);
    const db = getDB();

    // Проверяем, что заказ назначен
    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND status = "assigned"',
      orderId
    );
    if (!assignment) {
      throw new Error('Заказ не назначен');
    }

    // Сохраняем userId для уведомления
    const userId = assignment.user_id;

    // Удаляем назначение (без увеличения счётчика отмен)
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);

    // Уведомляем пользователя и модераторов
    notifyUser(userId, 'order_unassigned', { orderId, reason: 'Снят администратором' });
    notifyModerators('order_unassigned', { orderId, userId, adminId, reason: 'Снят администратором' });

    // Возвращаем заказ в очередь
    await this.reloadQueue();

    return { success: true };
  }

  // =================================================================
  // 6. ПОЛУЧЕНИЕ ЭТИКЕТКИ
  // =================================================================
  static async getLabel(orderId, userId) {
    const db = getDB();
    // Проверяем, что заказ завершён и принадлежит пользователю
    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND user_id = ? AND status = "completed"',
      orderId, userId
    );
    if (!assignment) {
      throw new Error('Заказ не найден или не завершён');
    }

    // Проверяем статус заказа в Ozon
    const details = await OzonService.getOrderDetails(orderId);
    if (!details || details.status !== 'awaiting_deliver') {
      throw new Error('Этикетка ещё не доступна');
    }

    return await OzonService.getPackageLabel(orderId);
  }

  static async getAllLabels(userId) {
    const db = getDB();
    const completed = await db.all(
      'SELECT order_id FROM assignments WHERE user_id = ? AND status = "completed"',
      userId
    );
    const buffers = [];
    for (const order of completed) {
      try {
        const label = await OzonService.getPackageLabel(order.order_id);
        if (label) buffers.push(label);
      } catch (err) {
        console.error(`[getAllLabels] Ошибка получения этикетки для ${order.order_id}:`, err);
      }
    }
    if (!buffers.length) return null;
    const { mergePdfs } = require('../utils');
    return await mergePdfs(buffers);
  }

  // =================================================================
  // 7. ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ДЛЯ РАБОТЫ С ОЧЕРЕДЬЮ
  // =================================================================

  static getCurrentOrder() {
    return currentOrderProcessing?.order || null;
  }

  static getPendingOrders() {
    return pendingNewOrders;
  }

  static async reloadQueue() {
    console.log('[OrderService] Принудительная перезагрузка очереди');
    pendingNewOrders = [];
    currentOrderProcessing = null;
    await this.checkNewOrders();
  }

// =================================================================
  // 7.5 ПРИВЯЗКА ФОТОГРАФИЙ К ТОВАРАМ С ИСПОЛЬЗОВАНИЕМ КЭША
  // =================================================================
  // Для каждого offer_id фото грузятся с Ozon только один раз и кладутся в in-memory кэш
  // (productImagesCache). При повторных запросах (обновлении страниц админом/пользователем)
  // фото берутся из кэша. При завершении заказа кэш по его offer_id очищается (см. finishOrder).
  static async attachProductImages(products) {
    if (!Array.isArray(products) || !products.length) return products || [];

    const needSkus = new Set(); // SKU, для которых фото ещё нет ни в кэше, ни в товаре

    // 1. Привязываем фото из кэша по offer_id
    for (const p of products) {
      if (p.offer_id) {
        const cached = productImagesCache.get(String(p.offer_id));
        if (cached && cached.images && cached.images.length) {
          p.images = cached.images.map(url => ({ url, name: p.name }));
        } else if (p.sku) {
          needSkus.add(String(p.sku));
        }
      } else if (p.sku) {
        // У товара нет offer_id — грузим по sku (кэшировать некуда)
        needSkus.add(String(p.sku));
      }
    }

    // 2. Догружаем с Ozon только недостающие фото
    if (needSkus.size) {
      const imageMap = await OzonService.fetchProductsImages(Array.from(needSkus));
      for (const p of products) {
        if (p.images || !p.sku) continue;
        const urls = imageMap[String(p.sku)];
        if (!urls || !urls.length) continue;
        p.images = urls.map(url => ({ url, name: p.name }));
        if (p.offer_id) {
          productImagesCache.set(String(p.offer_id), {
            sku: String(p.sku),
            images: urls,
            updatedAt: Date.now(),
          });
        }
      }
    }

    // 3. Если фото не нашлось — ставим пустой массив
    for (const p of products) {
      if (!p.images) p.images = [];
    }

    return products;
  }

  // =================================================================
  // 8. ОЧИСТКА СОСТОЯНИЙ ЗАКАЗА (из commands.js clearOrderState)
  // =================================================================
  static async clearOrderState(orderId, userId = null) {
    console.log(`[CLEAR] Начало очистки заказа ${orderId}${userId ? ` для пользователя ${userId}` : ''}`);

    // Очищаем pendingForms
    if (userId) {
      const key = `${userId}_${orderId}`;
      if (pendingForms.has(key)) {
        pendingForms.delete(key);
      }
    } else {
      for (const [key, state] of pendingForms) {
        if (state.orderId === orderId) {
          pendingForms.delete(key);
          break;
        }
      }
    }

    // Очищаем pendingFinishConfirmations
    if (pendingFinishConfirmations.has(orderId)) {
      pendingFinishConfirmations.delete(orderId);
    }

    // Очищаем finishingOrders
    if (finishingOrders.has(orderId)) {
      finishingOrders.delete(orderId);
    }

    console.log(`[CLEAR] Завершена очистка заказа ${orderId}`);
  }
}

module.exports = OrderService;
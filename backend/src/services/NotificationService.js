const { getDB } = require('../config/database');
const Notification = require('../models/Notification');
const { notifyUser, notifyModerators } = require('../socket');

// ============================================================================
// Роли персонала: кому доступны журнал действий сотрудников и ошибки сервера.
// Каждому пользователю с этой ролью создаётся СВОЯ копия оповещения
// (массив админов/модераторов поддерживается автоматически).
// Чтобы добавить/убрать роль — достаточно править этот массив.
// ============================================================================
const STAFF_ROLES = ['admin', 'moderator'];

// ============================================================================
// Шаблоны текстов оповещений.
// Каждая функция получает payload и возвращает тексты для двух аудиторий:
//   user  — личное оповещение сотрудника/админа
//   staff — запись в журнале действий (для админов/модераторов)
// Если для аудитории текста нет — оповещение этой аудитории не создаётся.
// ============================================================================
const TEMPLATES = {
  order_assigned: (p) => {
    const productsCount = p.details?.products?.length || 0;
    const missing =
      Array.isArray(p.missingStats) && p.missingStats.length
        ? ` Требуется заполнить статистику: ${p.missingStats.join(', ')}.`
        : '';
    const assignedBy = p.adminName ? ` Назначил: ${p.adminName}.` : '';
    return {
      user: {
        title: `📦 Заказ ${p.orderId} назначен вам`,
        message: `Вам назначен заказ ${p.orderId}. Товаров: ${productsCount}.${missing}`,
      },
      staff: {
        title: `📦 ${p.userName}: назначен заказ ${p.orderId}`,
        message: `Заказ ${p.orderId} назначен сотруднику ${p.userName}. Товаров: ${productsCount}.${assignedBy}${missing}`,
      },
    };
  },

  order_finished: (p) => {
    const earningsStr =
      p.earnings !== null && p.earnings !== undefined
        ? ` Заработок: ${p.earnings} руб.`
        : '';
    return {
      user: {
        title: `✅ Заказ ${p.orderId} завершён`,
        message: p.labelAvailable
          ? `Заказ ${p.orderId} завершён. Этикетка доступна для скачивания.${earningsStr}`
          : `Заказ ${p.orderId} завершён.${earningsStr}`,
      },
      staff: {
        title: `✅ ${p.userName}: завершил заказ ${p.orderId}`,
        message: `Сотрудник ${p.userName} завершил заказ ${p.orderId}.${earningsStr}`,
      },
    };
  },

  order_cancelled: (p) => ({
    user: {
      title: `❌ Вы отменили заказ ${p.orderId}`,
      message: `Заказ ${p.orderId} отменён и возвращён в очередь.`,
    },
    staff: {
      title: `❌ ${p.userName}: отменил заказ ${p.orderId}`,
      message: `Сотрудник ${p.userName} отменил заказ ${p.orderId} (возвращён в очередь).`,
    },
  }),

  order_unassigned: (p) => {
    if (p.auto) {
      return {
        user: {
          title: `↩️ Заказ ${p.orderId} снят автоматически`,
          message: `Заказ ${p.orderId} снят с вас автоматически. Причина: ${p.reason || 'не указана'}.`,
        },
        staff: {
          title: `↩️ ${p.userName}: заказ ${p.orderId} снят автоматически`,
          message: `Заказ ${p.orderId} автоматически снят с ${p.userName}. Причина: ${p.reason || 'не указана'}.`,
        },
      };
    }
    return {
      user: {
        title: `↩️ Заказ ${p.orderId} снят администратором`,
        message: `Заказ ${p.orderId} снят с вас администратором.`,
      },
      staff: {
        title: `↩️ ${p.userName}: снят заказ ${p.orderId}`,
        message: `Заказ ${p.orderId} снят с сотрудника ${p.userName}. Причина: ${p.reason || 'не указана'}.`,
      },
    };
  },

  earnings_adjusted: (p) => ({
    user: {
      title: `💰 Корректировка заработка: ${p.amount > 0 ? '+' : ''}${p.amount} руб.`,
      message: `Ваш заработок скорректирован на ${p.amount > 0 ? '+' : ''}${p.amount} руб.${p.adminName ? ` Администратор: ${p.adminName}.` : ''}${p.reason ? ` Причина: ${p.reason}` : ''}`,
    },
    // В журнал действий для персонала не дублируем (сотрудник получит своё)
    staff: null,
  }),

  earnings_settled: (p) => ({
    user: {
      title: `🏦 Произведён расчёт заработка`,
      message: `Активный заработок обнулён. Выплачено: ${Number(p.amount || 0).toFixed(2)} руб.${p.adminName ? ` Расчёт произвёл: ${p.adminName}.` : ''}`,
    },
    // В журнал действий для персонала не дублируем
    staff: null,
  }),

  // Заработок уже 0: отправляется только через WebSocket (persist: false),
  // в историю «Оповещений» не попадает
  earnings_settled_zero: (p) => ({
    user: {
      title: `🏦 Расчёт заработка`,
      message: `Активный заработок пуст (0 руб.) — рассчитывать нечего.${p.adminName ? ` Запросил: ${p.adminName}.` : ''}`,
    },
    staff: null,
  }),

  stats_filled: (p) => ({
    user: null,
    staff: {
      title: `📝 ${p.userName}: заполнил статистику ${p.offerId}`,
      message: `Сотрудник ${p.userName} заполнил статистику для ${p.offerId}: материал — ${p.material}, цвет — ${p.color}, вес — ${p.weight} г.`,
    },
  }),

  taking_orders_changed: (p) => ({
    user: null,
    staff: {
      title: `🔄 ${p.userName}: ${p.takingOrders ? 'включил' : 'выключил'} приём заказов`,
      message: `Сотрудник ${p.userName} ${p.takingOrders ? 'снова принимает' : 'перестал принимать'} заказы.`,
    },
  }),

  new_orders_available: (p) => ({
    user: null,
    staff: {
      title: `🆕 Новые заказы в очереди: ${p.count}`,
      message: `В очереди появилось ${p.count} новых заказов, ожидающих назначения.`,
    },
  }),

  order_assign_error: (p) => ({
    user: null,
    staff: {
      title: `⚠️ Ошибка при назначении заказа ${p.orderId}`,
      message: `Не удалось завершить назначение заказа ${p.orderId}${p.userName ? ` (${p.userName})` : ''}: ${p.error || 'неизвестная ошибка'}.`,
    },
  }),

  order_assign_failed: (p) => ({
    user: null,
    staff: {
      title: `🚨 Заказ ${p.orderId} не удалось назначить`,
      message: `После ${p.attempts || 3} попыток заказ ${p.orderId} не назначен: ${p.error || 'неизвестная ошибка'}.`,
    },
  }),
};

/**
 * Извлекает поля для быстрого поиска из payload:
 *   orderId   — номер заказа;
 *   userName  — имя сотрудника;
 *   offerIds  — артикулы товаров (строка через запятую). Берутся из
 *               payload.offerIds (явно), payload.details.products[].offer_id
 *               (OrderDetails при назначении) или payload.earningsDetails[].offerId
 *               (детализация заработка при завершении).
 * Сохраняются в колонки order_id / user_name / offer_ids notifications.db.
 */
function extractSearchFields(payload) {
  let offerIds = [];
  if (Array.isArray(payload?.offerIds)) {
    offerIds = payload.offerIds;
  } else if (Array.isArray(payload?.details?.products)) {
    offerIds = payload.details.products.map((p) => p.offer_id).filter(Boolean);
  } else if (Array.isArray(payload?.earningsDetails)) {
    offerIds = payload.earningsDetails.map((item) => item.offerId).filter(Boolean);
  }
  const uniqueOfferIds = Array.from(new Set(offerIds.map(String)));

  return {
    orderId:
      payload && payload.orderId != null ? String(payload.orderId) : null,
    userName:
      payload && payload.userName != null ? String(payload.userName) : null,
    offerIds: uniqueOfferIds.length ? uniqueOfferIds.join(',') : null,
  };
}

class NotificationService {
  /**
   * Роли персонала (журнал действий + ошибки сервера).
   */
  static get staffRoles() {
    return STAFF_ROLES;
  }

  /**
   * Персональное оповещение пользователю: запись в notifications.db + WebSocket.
   * Никогда не бросает исключений — сбой оповещений не должен ломать бизнес-логику.
   *
   * @param {number} userId
   * @param {string} type
   * @param {object} payload
   * @param {object} opts - { persist = true }. persist: false — ТОЛЬКО мгновенная
   *   доставка через WebSocket (toast), БЕЗ записи в историю «Оповещений».
   *   Используется для незначимых/информационных событий (например,
   *   «заработок уже 0, рассчитывать нечего»).
   */
  static async notifyUser(userId, type, payload = {}, { persist = true } = {}) {
    try {
      const tpl = TEMPLATES[type] ? TEMPLATES[type](payload) : null;
      const text = tpl && tpl.user;
      if (!text) return;

      const search = extractSearchFields(payload);
      let id = null;
      if (persist) {
        id = await Notification.create({
          recipientId: userId,
          audience: 'user',
          type,
          title: text.title,
          message: text.message,
          payload,
          ...search,
        });
      }

      // Мгновенная доставка через WebSocket (если пользователь онлайн)
      notifyUser(userId, 'notification_new', {
        id,
        audience: 'user',
        type,
        title: text.title,
        message: text.message,
        payload,
        createdAt: Date.now(),
        transient: !persist,
      });
    } catch (err) {
      console.error(
        `[NotificationService] Не удалось сохранить оповещение для пользователя ${userId}:`,
        err.message
      );
    }
  }

  /**
   * Оповещение всему персоналу (админы + модераторы): каждому своя строка в БД.
   * Никогда не бросает исключений.
   */
  static async notifyStaff(type, payload = {}) {
    try {
      const tpl = TEMPLATES[type] ? TEMPLATES[type](payload) : null;
      const text = tpl && tpl.staff;
      if (!text) return;

      const db = getDB();
      const recipients = await db.all(
        `SELECT id FROM users WHERE role IN (${STAFF_ROLES.map(() => '?').join(',')}) AND is_fired = 0`,
        ...STAFF_ROLES
      );
      if (!recipients.length) return;

      const createdAt = Date.now();
      const search = extractSearchFields(payload);
      await Notification.createMany(
        recipients.map((r) => ({
          recipientId: r.id,
          audience: 'staff',
          type,
          title: text.title,
          message: text.message,
          payload,
          ...search,
          createdAt,
        }))
      );

      // Мгновенная доставка тем, кто онлайн
      notifyModerators('notification_new', {
        audience: 'staff',
        type,
        title: text.title,
        message: text.message,
        payload,
        createdAt,
      });
    } catch (err) {
      console.error(
        '[NotificationService] Не удалось сохранить оповещение для персонала:',
        err.message
      );
    }
  }

  /**
   * Сохранить ошибку сервера в отдельный журнал (notifications.db -> server_errors)
   * и мгновенно сообщить персоналу через WebSocket. Никогда не бросает исключений.
   *
   * @param {string} source - источник ошибки ('express', 'OrderService', 'scheduler.backup', ...)
   * @param {Error|any} err
   * @param {object|null} context - произвольный контекст (orderId, userId и т.п.)
   * @param {'error'|'warn'} level
   */
  static async logServerError(source, err, context = null, level = 'error') {
    try {
      const message = err?.message || String(err);
      const id = await Notification.addError({
        level,
        source,
        message,
        stack: err?.stack || null,
        context,
      });

      notifyModerators('server_error_new', {
        id,
        level,
        source,
        message,
        createdAt: Date.now(),
      });
    } catch (logErr) {
      console.error(
        '[NotificationService] Не удалось сохранить ошибку сервера:',
        logErr.message
      );
    }
  }
}

module.exports = NotificationService;

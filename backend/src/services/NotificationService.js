const { getDB } = require('../config/database');
const Notification = require('../models/Notification');
const { notifyUser, notifyModerators, notifyStaffLive } = require('../socket');

// ============================================================================
// Роли персонала: кому создаётся запись в архиве журнала действий сотрудников.
// Каждому пользователю с этой ролью создаётся СВОЯ копия оповещения
// (массив админов/модераторов/создателя поддерживается автоматически).
// Чтобы добавить/убрать роль — достаточно править этот массив.
//
// Live-доставка через WebSocket:
//   • события о действиях сотрудников (notifyStaff) в реальном времени
//     получает ТОЛЬКО роль 'moderator' (комната 'moderators' в socket.js);
//   • остальные роли персонала (admin, god) читают действия сотрудников
//     в архиве журнала (страница «Оповещения» -> вкладка «Персонал»);
//   • ошибки сервера (logServerError) доставляются live всему персоналу
//     (комната 'staff').
// ============================================================================
const STAFF_ROLES = ['admin', 'moderator', 'god'];

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
        ? `Требуется заполнить статистику: ${p.missingStats.join(', ')}.`
        : '';
    const assignedBy = p.adminName ? `Назначил: ${p.adminName}.` : '';
    return {
      user: {
        title: `📦 Заказ ${p.orderId} назначен вам`,
        message: `Вам назначен заказ ${p.orderId}.\nТоваров: ${productsCount}.\n${missing}`,
      },
      staff: {
        title: `📦 ${p.userName}: назначен заказ ${p.orderId}`,
        message: `Заказ ${p.orderId} назначен сотруднику ${p.userName}.\nТоваров: ${productsCount}.\n${missing}\n${assignedBy}`,
      },
    };
  },

  order_finished: (p) => {
    const earningsStr =
      p.earnings !== null && p.earnings !== undefined
        ? `Заработок: ${p.earnings} руб.`
        : '';
    return {
      user: {
        title: `✅ Заказ ${p.orderId} завершён`,
        message: p.labelAvailable
          ? `Заказ ${p.orderId} завершён. Этикетка доступна для скачивания.\n${earningsStr}`
          : `Заказ ${p.orderId} завершён.\n${earningsStr}`,
      },
      staff: {
        title: `✅ ${p.userName}: завершил заказ ${p.orderId}`,
        message: `Сотрудник ${p.userName} завершил заказ ${p.orderId}.\n${earningsStr}`,
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
          message: `Заказ ${p.orderId} снят с вас автоматически.\nПричина: ${p.reason || 'не указана'}.`,
        },
        staff: {
          title: `↩️ ${p.userName}: заказ ${p.orderId} снят автоматически`,
          message: `Заказ ${p.orderId} автоматически снят с ${p.userName}.\nПричина: ${p.reason || 'не указана'}.`,
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
        message: `Заказ ${p.orderId} снят с сотрудника ${p.userName}.\nПричина: ${p.reason || 'не указана'}.${p.adminName ? `\nАдминистратор: ${p.adminName}.` : ''}`,
      },
    };
  },

  earnings_adjusted: (p) => ({
    user: {
      title: `💰 Корректировка заработка: ${p.amount > 0 ? '+' : ''}${p.amount} руб.`,
      message: `Ваш заработок скорректирован на ${p.amount > 0 ? '+' : ''}${p.amount} руб.${p.adminName ? `\nАдминистратор: ${p.adminName}.` : ''}${p.reason ? `\nПричина: ${p.reason}` : ''}`,
    },
    // В журнал действий для персонала не дублируем (сотрудник получит своё)
    staff: {
      title: `💰 Корректировка заработка: ${p.amount > 0 ? '+' : ''}${p.amount} руб.`,
      message: `Заработок сотрудника ${p.userName} скорректирован на ${p.amount > 0 ? '+' : ''}${p.amount} руб.${p.reason ? `\nПричина: ${p.reason}` : ''}${p.adminName ? `\nАдминистратор: ${p.adminName}.` : ''}`,
    },
  }),

  earnings_settled: (p) => ({
    user: {
      title: `🏦 Произведён расчёт заработка`,
      message: `Активный заработок обнулён.\nВыплачено: ${Number(p.amount || 0).toFixed(2)} руб.${p.adminName ? `\nРасчёт произвёл: ${p.adminName}.` : ''}`,
    },
    // В журнал действий для персонала не дублируем
    staff: {
      title: `🏦 Произведён расчёт заработка`,
      message: `Активный заработок сотрудника ${p.userName} обнулён.\nВыплачено: ${Number(p.amount || 0).toFixed(2)} руб.${p.adminName ? `\nРасчёт произвёл: ${p.adminName}.` : ''}`,
    },
  }),

  // Заработок уже 0: отправляется только через WebSocket (persist: false),
  // в историю «Оповещений» не попадает
  earnings_settled_zero: (p) => ({
    user: {
      title: `🏦 Расчёт заработка`,
      message: `Активный заработок пуст (0 руб.) — рассчитывать нечего.${p.adminName ? `\nЗапросил: ${p.adminName}.` : ''}`,
    },
    staff: null,
  }),

  stats_filled: (p) => ({
    user: null,
    staff: {
      title: `📝 ${p.userName}: заполнил статистику ${p.offerId}`,
      message: `Сотрудник ${p.userName} заполнил статистику для ${p.offerId}: \nМатериал — ${p.material}\nЦвет — ${p.color}\nВес — ${p.weight} г.`,
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

  // Этикетка, отправленная сотруднику администратором (аналог /admin_send_label).
  // PDF сохраняется на сервере (outputs/labels/<orderId>.pdf) и скачивается
  // сотрудником по кнопке в оповещении (GET /user/labels/:orderId/sent).
  label_sent: (p) => ({
    user: {
      title: `🏷️ Этикетка заказа ${p.orderId}`,
      message: `${p.adminName || 'Администратор'} отправил вам этикетку заказа ${p.orderId}.\nНажмите «Скачать этикетку», чтобы сохранить PDF.`,
    },
    staff: {
      title: `🏷️ ${p.adminName || 'Администратор'}: отправил этикетку ${p.orderId}`,
      message: `${p.adminName || 'Администратор'} отправил этикетку заказа ${p.orderId} сотруднику ${p.userName || '—'}.`,
    },
  }),

  // ==========================================================================
  // Напоминания о неотправленных заказах (статус awaiting_deliver).
  // Создаются планировщиком awaiting_deliver (scheduler.js) раз в сутки:
  //   user  — лично сотруднику, чей заказ «висит» без отправки;
  //   staff — копия в журнал действий персоналу (модераторы получают её
  //           ещё и live через WebSocket, как обычные действия сотрудников).
  // ==========================================================================
  deliver_reminder: (p) => {
    const products = Array.isArray(p.details?.products) ? p.details.products : [];
    const shown = products.slice(0, 3);
    const more = products.length - shown.length;
    const productsLine = products.length
      ? `\nТовары: ${shown
          .map((pr) => `${pr.name || '—'}${pr.offer_id ? ` (${pr.offer_id})` : ''} — ${pr.quantity || 1} шт.`)
          .join('; ')}${more > 0 ? ` … и ещё ${more}` : ''}.`
      : '';
    const earningsLine =
      p.amount != null ? `\n💰 Заработок по заказу: ${p.amount} руб.` : '';
    const repeatedLine =
      p.reminderCount > 0 ? `\n🔔 Ранее вам уже напоминали: ${p.reminderCount} раз(а).` : '';

    return {
      user: {
        title: `⏰ Заказ ${p.orderId} не отправлен`,
        message:
          `Заказ ${p.orderId} был завершён ${p.daysPassed} дн. назад, но всё ещё находится в статусе «ожидает отправки».` +
          repeatedLine +
          earningsLine +
          productsLine +
          `\n⚠️ Пожалуйста, отправьте заказ как можно скорее, иначе заработок может быть отменён.`,
      },
      staff: {
        title: `⏰ ${p.userName || 'Сотрудник'}: заказ ${p.orderId} не отправлен`,
        message:
          `Сотрудник ${p.userName || 'Неизвестно'} завершил заказ ${p.orderId} ${p.daysPassed} дн. назад, но заказ всё ещё в статусе «ожидает отправки».` +
          `\n🔔 Напоминаний отправлено: ${(p.reminderCount || 0) + 1}.` +
          earningsLine +
          productsLine,
      },
    };
  },

  // Итог ежедневной проверки «ожидает отправки» — только персоналу.
  deliver_reminder_summary: (p) => ({
    user: null,
    staff: {
      title: `📋 Проверка «ожидает отправки» завершена`,
      message: `Найдено проблемных заказов: ${p.found ?? 0}.\nНапоминаний отправлено сотрудникам: ${p.sent ?? 0}.`,
    },
  }),

  // Автоматический ежемесячный экспорт заработка (планировщик) — только персоналу.
  monthly_export_done: (p) => ({
    user: null,
    staff: {
      title: `📊 Экспорт заработка за ${p.month} выполнен`,
      message: `Автоматический экспорт заработка за ${p.month} выполнен.\nФайл: ${p.file || '—'}.`,
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
   * Оповещение персоналу: каждому получателю своя строка в БД.
   * Никогда не бросает исключений.
   *
   * @param {string} type
   * @param {object} payload
   * @param {object} opts
   *   roles            — массив ролей-получателей (по умолчанию все STAFF_ROLES);
   *                      например ['moderator'] для информационных оповещений,
   *                      интересных только модераторам.
   *   replaceUnreadType— если задан тип, перед вставкой нового оповещения
   *                      удаляются все НЕПРОЧИТАННЫЕ оповещения этого типа
   *                      (дедупликация: подобное оповещение всегда ОДНО).
   */
  static async notifyStaff(type, payload = {}, { roles = null, replaceUnreadType = null } = {}) {
    try {
      const tpl = TEMPLATES[type] ? TEMPLATES[type](payload) : null;
      const text = tpl && tpl.staff;
      if (!text) return;

      const notifyRoles = Array.isArray(roles) && roles.length ? roles : STAFF_ROLES;
      const db = getDB();
      const recipients = await db.all(
        `SELECT id FROM users WHERE role IN (${notifyRoles.map(() => '?').join(',')}) AND is_fired = 0`,
        ...notifyRoles
      );
      if (!recipients.length) return;

      // Дедупликация: старое непрочитанное оповещение того же типа удаляем
      if (replaceUnreadType) {
        await Notification.deleteUnreadByType(replaceUnreadType, 'staff');
      }

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

      // recipients ограничен ролями (см. opts.roles) — live-доставка через
      // комнату 'moderators' соответствует получателям по умолчанию, а при
      // сужении круга (например, только модераторы) она им и предназначена.
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

// src/scheduler.js
const { getLocalTime, getLocalDate, getLocalTimestamp } = require('./utils');
const OrderService = require('./services/OrderService');
const OzonService = require('./services/OzonService');
const EarningsService = require('./services/EarningsService');
const BackupService = require('./services/BackupService');
const Notification = require('./models/Notification');
const NotificationService = require('./services/NotificationService');

let checkInterval = null;
let isPaused = false;

/**
 * Запускает периодическую проверку новых заказов из Ozon
 */
function startOrderChecker(intervalMinutes, callback) {
  if (checkInterval) clearInterval(checkInterval);
  checkInterval = setInterval(async () => {
    if (isPaused) return;
    console.log(`[SCHEDULER] Проверка заказов в ${getLocalTimestamp()}`);
    try {
      await callback();
    } catch (err) {
      console.error('[SCHEDULER] Ошибка в планировщике:', err);
      NotificationService.logServerError('scheduler.orderChecker', err);
    }
  }, intervalMinutes * 60 * 1000);
}

function stopOrderChecker() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

function pauseChecker() { isPaused = true; }
function resumeChecker() { isPaused = false; }
function isCheckerPaused() { return isPaused; }

// --- Очистка кулдаунов (пока заглушка) ---
let cooldownCleanInterval = null;
function startCooldownCleaner() {
  if (cooldownCleanInterval) clearInterval(cooldownCleanInterval);
  cooldownCleanInterval = setInterval(() => {
    // В веб-версии кулдауны хранятся в Redis или в памяти – пока пропускаем
    console.log('[SCHEDULER] Очистка кулдаунов (заглушка)');
  }, 60 * 60 * 1000);
}
function stopCooldownCleaner() {
  if (cooldownCleanInterval) {
    clearInterval(cooldownCleanInterval);
    cooldownCleanInterval = null;
  }
}

// --- Ежедневный бэкап БД ---
let backupInterval = null;
function startDailyBackupChecker() {
  if (backupInterval) clearInterval(backupInterval);
  backupInterval = setInterval(async () => {
    try {
      const localTime = getLocalTime();
      if (localTime.hours === 0 && localTime.minutes === 0) {
        console.log('[SCHEDULER] Запуск ежедневного автобэкапа БД...');
        await BackupService.createDbBackup();
        // Можно отправить уведомление администратору (через WebSocket или email)
      }
    } catch (err) {
      console.error('[SCHEDULER] Ошибка автобэкапа:', err);
      NotificationService.logServerError('scheduler.backup', err);
    }
  }, 60 * 60 * 1000);
}
function stopDailyBackupChecker() {
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
  }
}

// --- Очистка акций (ежедневно) ---
let promotionCleanInterval = null;
let isPromotionCleanRunning = false;

function startDailyPromotionCleaner() {
  if (promotionCleanInterval) {
    clearInterval(promotionCleanInterval);
    promotionCleanInterval = null;
  }

  const targetHour = parseInt(process.env.PROMOTION_CLEAN_HOUR) || 3;
  const targetMinute = parseInt(process.env.PROMOTION_CLEAN_MINUTE) || 0;

  promotionCleanInterval = setInterval(async () => {
    if (isPromotionCleanRunning) {
      console.log('[SCHEDULER] Очистка акций уже выполняется, пропускаем');
      return;
    }

    const localTime = getLocalTime();
    if (localTime.hours === targetHour && localTime.minutes === targetMinute) {
      isPromotionCleanRunning = true;
      try {
        console.log('[SCHEDULER] Запуск ежедневной очистки акций...');
        const progressCallback = (text) => {
          console.log(`[PROMOTION_CLEAN] ${text}`);
          // Можно отправлять уведомления через WebSocket или в лог
        };
        const result = await OzonService.removeAllPromotions(progressCallback);
        console.log(`[SCHEDULER] Очистка акций завершена: ${result.actionsProcessed} акций, ${result.totalProductsRemoved} товаров`);
      } catch (err) {
        console.error('[SCHEDULER] Ошибка очистки акций:', err);
        NotificationService.logServerError('scheduler.promotionClean', err);
      } finally {
        isPromotionCleanRunning = false;
      }
    }
  }, 60 * 1000); // проверяем каждую минуту

  console.log(`[SCHEDULER] Ежедневная очистка акций запланирована на ${targetHour}:${String(targetMinute).padStart(2, '0')}`);
}

function stopDailyPromotionCleaner() {
  if (promotionCleanInterval) {
    clearInterval(promotionCleanInterval);
    promotionCleanInterval = null;
  }
  isPromotionCleanRunning = false;
}

// --- Ежемесячный экспорт заработка ---
let monthlyExportInterval = null;

function startMonthlyExportChecker() {
  if (monthlyExportInterval) clearInterval(monthlyExportInterval);
  monthlyExportInterval = setInterval(async () => {
    try {
      const localDate = getLocalDate();
      // Проверяем, последний ли день месяца и время после 23:00
      const lastDayOfMonth = new Date(localDate.getFullYear(), localDate.getMonth() + 1, 0).getDate();
      if (localDate.getDate() === lastDayOfMonth && localDate.getHours() >= 23) {
        // Предыдущий месяц
        const prevMonth = new Date(localDate.getFullYear(), localDate.getMonth() - 1, 1);
        const monthStr = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
        console.log(`[SCHEDULER] Запуск автоматического экспорта за ${monthStr}`);
        await EarningsService.exportMonthlyEarnings(monthStr);
        // Можно уведомить админа
      }
    } catch (err) {
      console.error('[SCHEDULER] Ошибка автоматического экспорта:', err);
      NotificationService.logServerError('scheduler.monthlyExport', err);
    }
  }, 60 * 60 * 1000);
}

function stopMonthlyExportChecker() {
  if (monthlyExportInterval) {
    clearInterval(monthlyExportInterval);
    monthlyExportInterval = null;
  }
}

// --- Ежедневная очистка notifications.db (ретенция оповещений и ошибок) ---
// Запускается раз в сутки по локальному времени (по умолчанию в 03:00 —
// NOTIFICATIONS_CLEANUP_HOUR / NOTIFICATIONS_CLEANUP_MINUTE):
//   • оповещения старше NOTIFICATIONS_RETENTION_DAYS дней (по умолчанию 7);
//   • ошибки сервера старше SERVER_ERRORS_RETENTION_DAYS дней (по умолчанию 14).
// Если сервер в целевое время был выключен — очистка выполнится при первом
// запуске планировщика после него (но не чаще одного раза в сутки).
let notificationsCleanupInterval = null;
let isNotificationsCleanupRunning = false;
let lastNotificationsCleanupDate = null;

function startNotificationsCleanup() {
  if (notificationsCleanupInterval) clearInterval(notificationsCleanupInterval);

  const targetHour = parseInt(process.env.NOTIFICATIONS_CLEANUP_HOUR) || 3;
  const targetMinute = parseInt(process.env.NOTIFICATIONS_CLEANUP_MINUTE) || 0;

  notificationsCleanupInterval = setInterval(async () => {
    if (isNotificationsCleanupRunning) return;

    // Проверяем каждую минуту: наступило ли время очистки сегодня
    const localTime = getLocalTime();
    const minutesNow = localTime.hours * 60 + localTime.minutes;
    const minutesTarget = targetHour * 60 + targetMinute;
    if (minutesNow < minutesTarget) return;

    const today = getLocalDate().toDateString();
    if (lastNotificationsCleanupDate === today) return;
    lastNotificationsCleanupDate = today;

    isNotificationsCleanupRunning = true;
    try {
      const notifDays =
        parseInt(process.env.NOTIFICATIONS_RETENTION_DAYS) || 7;
      const errorDays =
        parseInt(process.env.SERVER_ERRORS_RETENTION_DAYS) || 14;

      const result = await Notification.pruneOld(notifDays, errorDays);
      if (result.notifications > 0 || result.errors > 0) {
        console.log(
          `[SCHEDULER] Очистка notifications.db: удалено ${result.notifications} оповещений старше ${notifDays} дн., ${result.errors} ошибок старше ${errorDays} дн.`
        );
      }
    } catch (err) {
      console.error('[SCHEDULER] Ошибка очистки оповещений:', err);
      NotificationService.logServerError('scheduler.notificationsCleanup', err);
    } finally {
      isNotificationsCleanupRunning = false;
    }
  }, 60 * 1000); // проверка каждую минуту

  console.log(
    `[SCHEDULER] Ежедневная очистка оповещений запланирована на ${targetHour}:${String(targetMinute).padStart(2, '0')}`
  );
}

function stopNotificationsCleanup() {
  if (notificationsCleanupInterval) {
    clearInterval(notificationsCleanupInterval);
    notificationsCleanupInterval = null;
  }
}

module.exports = {
  startOrderChecker,
  stopOrderChecker,
  pauseChecker,
  resumeChecker,
  isCheckerPaused,
  startCooldownCleaner,
  stopCooldownCleaner,
  startDailyBackupChecker,
  stopDailyBackupChecker,
  startDailyPromotionCleaner,
  stopDailyPromotionCleaner,
  startMonthlyExportChecker,
  stopMonthlyExportChecker,
  startNotificationsCleanup,
  stopNotificationsCleanup,
};
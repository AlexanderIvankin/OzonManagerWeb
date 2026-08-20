// src/scheduler.js
const { getLocalTime, getLocalDate } = require('./utils/utils');
const OrderService = require('./services/OrderService');
const OzonService = require('./services/OzonService');
const { createDbBackup } = require('./config/database'); // если добавим функцию бэкапа

let checkInterval = null;
let isPaused = false;

/**
 * Запускает периодическую проверку новых заказов из Ozon
 */
function startOrderChecker(intervalMinutes, callback) {
  if (checkInterval) clearInterval(checkInterval);
  checkInterval = setInterval(async () => {
    if (isPaused) return;
    console.log(`[SCHEDULER] Проверка заказов в ${new Date().toISOString()}`);
    try {
      await callback();
    } catch (err) {
      console.error('[SCHEDULER] Ошибка в планировщике:', err);
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
        await createDbBackup();
        // Можно отправить уведомление администратору (через WebSocket или email)
      }
    } catch (err) {
      console.error('[SCHEDULER] Ошибка автобэкапа:', err);
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
        await OrderService.exportMonthlyEarnings(monthStr);
        // Можно уведомить админа
      }
    } catch (err) {
      console.error('[SCHEDULER] Ошибка автоматического экспорта:', err);
    }
  }, 60 * 60 * 1000);
}

function stopMonthlyExportChecker() {
  if (monthlyExportInterval) {
    clearInterval(monthlyExportInterval);
    monthlyExportInterval = null;
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
};
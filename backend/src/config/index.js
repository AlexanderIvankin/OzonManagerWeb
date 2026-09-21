require('dotenv').config();

module.exports = {
  port: process.env.PORT || 5000,
  jwtSecret: process.env.JWT_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
  accessTokenExpiry: process.env.ACCESS_TOKEN_EXPIRY || '15m',
  refreshTokenExpiry: process.env.REFRESH_TOKEN_EXPIRY || '30d',
  // Создатель (роль 'god'): идентификаторы из .env. Роль выдаётся только
  // при синхронизации Excel (SyncService), вручную её выдать нельзя.
  godId: (process.env.GOD_ID || '').trim(),
  godEmail: (process.env.GOD_EMAIL || '').trim().toLowerCase(),
  // Неподтверждённые аккаунты (роль 'guest'):
  //   guestTtlHours — через сколько часов гостя удаляет планировщик
  //     (scheduler.startGuestCleanupChecker, GUEST_TTL_HOURS);
  //   resendCodeCooldownSec — минимальный интервал между отправками кода
  //     подтверждения (RESEND_CODE_COOLDOWN_SEC).
  guestTtlHours: parseInt(process.env.GUEST_TTL_HOURS, 10) || 24,
  resendCodeCooldownSec: parseInt(process.env.RESEND_CODE_COOLDOWN_SEC, 10) || 60,
};
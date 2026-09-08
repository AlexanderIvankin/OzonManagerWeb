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
};
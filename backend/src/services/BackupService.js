const fs = require('fs');
const path = require('path');
const { getDB, getDBPath } = require('../config/database');
const { formatLocalTimestamp, getDbBaseName, getVersionedDatedFileName } = require('../utils');

const BACKUP_DIR = path.join(__dirname, '../../backups');

/**
 * Сервис для создания бэкапов базы данных
 */
class BackupService {
  /**
   * Создаёт ежедневный бэкап базы данных в папку backups.
   * Если бэкап за сегодня уже существует — пропускает.
   * @returns {Promise<string|null>} - путь к созданному бэкапу или null
   */
  static async createDbBackup({ includeTime = false } = {}) {
    try {
      // Создаём папку для бэкапов, если её нет
      if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        console.log(`[Backup] Создана папка бэкапов: ${BACKUP_DIR}`);
      }

      const dbPath = getDBPath();
      if (!fs.existsSync(dbPath)) {
        console.error('[Backup] Файл базы данных не найден:', dbPath);
        return null;
      }

      let backupName;
      if (includeTime) {
        // Ручной бэкап (команда админа): уникальное имя с локальным временем
        // bot_web-1_2026-09-04_13-28-13.db | bot_web_2026-09-04_13-28-13.db
        backupName = getVersionedDatedFileName(getDbBaseName(), 'db', formatLocalTimestamp());
      } else {
        // Ежедневный бэкап (планировщик): только дата, один раз в день.
        // Локальная дата (TIMEZONE), а не UTC: бэкап в 00:00 по Москве
        // должен попадать на сегодняшний день, а не на вчерашний.
        const dateStr = formatLocalTimestamp().slice(0, 10); // YYYY-MM-DD
        // bot_web-1_2026-09-04.db | bot_web_2026-09-04.db
        backupName = getVersionedDatedFileName(getDbBaseName(), 'db', dateStr);
      }
      const backupPath = path.join(BACKUP_DIR, backupName);

      // Проверяем существование только для ежедневных бэкапов (без времени)
      if (!includeTime && fs.existsSync(backupPath)) {
        console.log(`[Backup] Бэкап за сегодня уже существует: ${backupPath}`);
        return backupPath;
      }

      // Принудительная синхронизация WAL (если используется)
      const db = getDB();
      if (db) {
        await db.run('PRAGMA wal_checkpoint;');
      }

      fs.copyFileSync(dbPath, backupPath);
      console.log(`[Backup] Бэкап создан: ${backupPath}`);
      return backupPath;
    } catch (err) {
      console.error('[Backup] Ошибка создания бэкапа:', err);
      throw err;
    }
  }
}

module.exports = BackupService;
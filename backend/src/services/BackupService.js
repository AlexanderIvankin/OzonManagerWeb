const fs = require('fs');
const path = require('path');
const { getDB } = require('../config/database');

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
  static async createDbBackup() {
    try {
      // Создаём папку для бэкапов, если её нет
      if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        console.log(`[Backup] Создана папка бэкапов: ${BACKUP_DIR}`);
      }

      const dbPath = process.env.DB_PATH || path.join(__dirname, '../../bot_web.db');
      if (!fs.existsSync(dbPath)) {
        console.error('[Backup] Файл базы данных не найден:', dbPath);
        return null;
      }

      const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const backupPath = path.join(BACKUP_DIR, `bot_web_${dateStr}.db`);

      if (fs.existsSync(backupPath)) {
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
// src/services/SyncService.js
const XLSX = require('xlsx');
const path = require('path');
const { User, Warehouse } = require('../models');
const { getDB } = require('../config/database');
const bcrypt = require('bcrypt');

/**
 * Сервис синхронизации пользователей из Excel.
 * Поддерживает синхронизацию по email (основной) или по tg_user_id.
 */
class SyncService {
  /**
   * Синхронизация из файла team-info.xlsx
   * @param {string} filePath - путь к файлу
   * @param {number} adminUserId - ID администратора (для лога)
   * @param {Object} options - { createMissing: boolean, syncBy: 'email' | 'tg' }
   * @returns {Promise<{ updated: number, created: number, skipped: number }>}
   */
  static async syncFromExcel(filePath, adminUserId, options = { createMissing: false, syncBy: 'email' }) {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!rows || rows.length < 3) {
      throw new Error('Файл слишком короткий или пустой');
    }

    // --- Заголовки: строка 1 (индекс 1) ---
    const headerRow = rows[1];
    // Проверяем, что в столбце B есть '@' – значит это email
    const emailHeader = (headerRow[1] || '').toLowerCase();
    if (!emailHeader.includes('email')) {
      console.warn('[Sync] Второй столбец, возможно, не email. Проверьте файл.');
    }

    // --- Определяем колонки складов (начиная с индекса 6, т.е. столбец G) ---
    const warehouseColumns = [];
    for (let col = 6; col < headerRow.length; col++) {
      const cellValue = headerRow[col];
      if (cellValue && typeof cellValue === 'string') {
        const match = cellValue.match(/ID:\s*(\d+)/i);
        if (match) {
          warehouseColumns.push({
            colIndex: col,
            warehouseId: match[1]
          });
        }
      }
    }

    // --- Парсим данные сотрудников (начиная со строки 2) ---
    const usersData = [];
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 6) continue; // минимум 6 колонок (A–F)

      const name = String(row[0] || '').trim();
      const email = String(row[1] || '').trim().toLowerCase();
      const tgUserId = String(row[2] || '').trim();
      const phone = String(row[3] || '').trim();
      const capacity = parseInt(row[4]) || 1;
      let earningsFactor = parseFloat(String(row[5]).replace(',', '.'));
      if (isNaN(earningsFactor) || earningsFactor <= 0) earningsFactor = 1.0;

      if (!name || (!email && !tgUserId)) {
        // Пропускаем строки без имени и без идентификатора
        continue;
      }

      // Собираем склады
      const warehouses = [];
      for (const colInfo of warehouseColumns) {
        const val = row[colInfo.colIndex];
        if (val === '+' || val === '➕' || val === '✔') {
          warehouses.push(colInfo.warehouseId);
        }
      }

      usersData.push({ name, email, tgUserId, phone, capacity, earningsFactor, warehouses });
    }

    const db = getDB();
    let updated = 0, created = 0, skipped = 0;

    for (const data of usersData) {
      // Поиск пользователя: если syncBy = 'email' и email есть – ищем по email, иначе по tgUserId
      let user = null;
      if (options.syncBy === 'email' && data.email) {
        user = await User.getByEmail(data.email);
      } else if (data.tgUserId) {
        // Ищем по tg_user_id (если email не найден или syncBy = 'tg')
        user = await User.findByTgId(data.tgUserId);
        // Если не нашли по tg, но есть email – пробуем по email (запасной вариант)
        if (!user && data.email) {
          user = await User.getByEmail(data.email);
        }
      } else {
        // Нет ни email, ни tg – пропускаем
        skipped++;
        continue;
      }

      if (user) {
        // Обновляем существующего
        const updateFields = {
          name: data.name,
          phone: data.phone || user.phone,
          capacity: data.capacity || user.capacity,
          earnings_factor: data.earningsFactor || user.earnings_factor,
        };
        // Если tgUserId указан и отличается – обновляем
        if (data.tgUserId && user.tg_user_id !== data.tgUserId) {
          updateFields.tg_user_id = data.tgUserId;
        }
        // Если роль была 'user' (не admin/moderator) – можно оставить как есть, не меняем
        // Если хотим повысить роль до 'employee' – можно, но пока оставим как есть.
        await User.update(user.id, updateFields);

        // Обновляем склады
        await Warehouse.clearUserWarehouses(user.id);
        for (const whId of data.warehouses) {
          await Warehouse.addUserWarehouse(user.id, whId);
        }
        updated++;
      } else if (options.createMissing) {
        // Создаём нового пользователя с минимальными данными (без пароля)
        // Для веб-версии мы не создаём пользователей автоматически, т.к. они должны регистрироваться сами.
        // Но если опция включена – создаём с ролью 'user' и без пароля (требуется сброс пароля).
        // Лучше пропустить, поэтому создание отключим по умолчанию.
        // Однако для полноты реализуем:
        const randomPassword = Math.random().toString(36).slice(-8);
        const passwordHash = await bcrypt.hash(randomPassword, 10);
        const newUser = await User.create({
          username: data.email || data.tgUserId || `user_${Date.now()}`,
          email: data.email || `user_${Date.now()}@temp.local`,
          passwordHash,
          name: data.name,
          phone: data.phone,
          capacity: data.capacity,
          earningsFactor: data.earningsFactor,
          role: 'user',
          tgUserId: data.tgUserId || null,
        });
        // Обновляем склады
        for (const whId of data.warehouses) {
          await Warehouse.addUserWarehouse(newUser.id, whId);
        }
        created++;
      } else {
        skipped++;
      }
    }

    console.log(`[SyncService] Синхронизация завершена: обновлено ${updated}, создано ${created}, пропущено ${skipped}`);
    return { updated, created, skipped };
  }
}

module.exports = SyncService;
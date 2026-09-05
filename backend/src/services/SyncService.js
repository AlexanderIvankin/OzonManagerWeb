const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const path = require('path');
const { User, Warehouse } = require('../models');
const { getDB } = require('../config/database');
const bcrypt = require('bcrypt');
const OzonService = require('./OzonService');
const { getVersionedFileName } = require('../utils');

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

  /**
    * Экспортирует пользователей и их склады в Excel (обратная синхронизация)
    * @param {number} adminUserId - ID администратора (для лога)
    * @param {boolean} includeFired - включать уволенных
    * @param {string} outputFileName - имя файла
    * @returns {Promise<string>} - путь к созданному файлу
    */
  static async exportTeamInfoXlsx(adminUserId, includeFired = false, outputFileName = 'team-info.xlsx', { syncWarehouses = true } = {}) {
    const db = getDB();

    // 1. Синхронизируем склады перед экспортом (по умолчанию; отключается при фоновой перегенерации)
    if (syncWarehouses) {
      try {
        const warehousesFromOzon = await OzonService.fetchWarehouses();
        if (warehousesFromOzon.length) {
          await Warehouse.syncAll(warehousesFromOzon);
          console.log('[SyncService] Склады синхронизированы перед экспортом');
        }
      } catch (err) {
        console.warn('[SyncService] Не удалось синхронизировать склады перед экспортом:', err.message);
      }
    }

    // 2. Получаем пользователей
    const users = await User.getAll({ includeFired, includeAll: true });
    const warehouses = await Warehouse.getAll();

    // 3. Получаем связи пользователь-склад
    const userWarehouses = await db.all('SELECT user_id, warehouse_id FROM user_warehouses');
    const map = new Map();
    for (const uw of userWarehouses) {
      if (!map.has(uw.user_id)) map.set(uw.user_id, new Set());
      map.get(uw.user_id).add(uw.warehouse_id);
    }

    // 4. Создаём Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Сотрудники');

    // Заголовки: Сотрудник, E-mail, Telegram ID, Телефон, Принтеров, Коэф., разделитель, склады
    const header1 = ['Сотрудник', 'E-mail', 'Telegram ID', 'Телефон', 'Число принтеров', 'Коэффициент Заработка', ''];
    const header2 = ['', '', '', '', '', '', ''];
    for (const wh of warehouses) {
      header1.push('');
      header2.push(`${wh.name} (ID: ${wh.warehouse_id})`);
    }

    const row1 = worksheet.addRow(header1);
    const row2 = worksheet.addRow(header2);

    // Слияние для "Склады"
    if (warehouses.length) {
      const startCol = 8;
      const endCol = 7 + warehouses.length;
      const startLetter = String.fromCharCode(64 + startCol);
      const endLetter = String.fromCharCode(64 + endCol);
      worksheet.mergeCells(`${startLetter}1:${endLetter}1`);
      row1.getCell(startCol).value = 'Склады';
    }

    // Стили
    [row1, row2].forEach(row => {
      row.eachCell(cell => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { bold: true };
      });
    });

    // Ширина
    const widths = [45, 45, 30, 30, 30, 30, 15];
    for (let i = 0; i < widths.length; i++) {
      worksheet.getColumn(i + 1).width = widths[i];
    }
    for (let i = 0; i < warehouses.length; i++) {
      worksheet.getColumn(8 + i).width = 75;
    }

    // Данные
    for (const user of users) {
      const whSet = map.get(user.id) || new Set();
      const rowData = [
        user.name,
        user.email || '',
        user.tg_user_id || '',
        user.phone || '',
        user.capacity,
        user.earnings_factor || 1.0,
        '',
      ];
      for (const wh of warehouses) {
        rowData.push(whSet.has(wh.warehouse_id) ? '+' : '');
      }
      const dataRow = worksheet.addRow(rowData);
      dataRow.eachCell((cell, colNum) => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        if (colNum === 3 || colNum === 4) cell.numFmt = '@'; // TG и телефон текстом
        if (colNum === 6) cell.numFmt = '0.00';
      });
    }

    // Имя файла версонируется, если задан BOT_VERSION:
    // team-info-1.xlsx | team-info.xlsx; employees-db-1.xlsx | employees-db.xlsx
    const baseName = outputFileName.replace(/\.xlsx$/i, '');
    const finalFileName = getVersionedFileName(baseName, 'xlsx');
    const outputPath = path.join(__dirname, '../../', finalFileName);
    await workbook.xlsx.writeFile(outputPath);
    console.log(`[SyncService] Экспорт в ${finalFileName} выполнен`);
    return outputPath;
  }
}

module.exports = SyncService;
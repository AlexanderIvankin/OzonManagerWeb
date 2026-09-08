const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { User, Warehouse } = require('../models');
const { getDB } = require('../config/database');
const bcrypt = require('bcrypt');
const OzonService = require('./OzonService');
const { getVersionedFileName } = require('../utils');
const config = require('../config');

/**
 * Идентификаторы Создателя читаются из .env НАПРЯМУЮ (с кэшем по mtime файла),
 * а не из кэша config, загруженного при старте сервера. Так правки
 * GOD_EMAIL/GOD_ID подхватываются при следующей синхронизации даже без
 * перезапуска сервера.
 * @returns {{ mtime: number|null, email: string, id: string }}
 */
let godEnvCache = { mtime: null, email: '', id: '' };
function readGodEnv() {
  try {
    const envPath = path.resolve(__dirname, '../../.env');
    const mtime = fs.existsSync(envPath) ? fs.statSync(envPath).mtimeMs : null;
    if (godEnvCache.mtime === mtime && mtime !== null) return godEnvCache;
    let email = '';
    let id = '';
    if (mtime !== null) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*(GOD_EMAIL|GOD_ID)\s*=\s*(.*)$/);
        if (!m) continue;
        // Снимаем возможные кавычки и хвостовые комментарии ("значение # коммент")
        const raw = m[2].trim();
        const val = raw.split('#')[0].trim().replace(/^["']|["']$/g, '');
        if (m[1] === 'GOD_EMAIL') email = val.toLowerCase();
        else id = val;
      }
    }
    godEnvCache = { mtime, email, id };
    console.log(
      `[SyncService] Идентификаторы Создателя: GOD_EMAIL="${email}", GOD_ID="${id}"`
    );
    return godEnvCache;
  } catch (err) {
    console.warn('[SyncService] Не удалось прочитать .env (GOD_EMAIL/GOD_ID):', err.message);
    return { mtime: null, email: '', id: '' };
  }
}

/**
 * Сервис синхронизации пользователей из Excel.
 * Поддерживает синхронизацию по email (основной) или по tg_user_id.
 */
class SyncService {
  /**
   * Проверяет, принадлежит ли запись из Excel Создателю (роль 'god').
   * Создатель всегда в единственном числе; его идентификаторы задаются
   * в .env: GOD_EMAIL (email) и GOD_ID (tg_user_id).
   * @param {{ email?: string, tgUserId?: string }} data
   * @returns {boolean}
   */
  static isGodIdentity(data) {
    const godEnv = readGodEnv();
    const godEmail = godEnv.email || config.godEmail;
    const godId = godEnv.id || config.godId;
    const email = String(data.email || '').trim().toLowerCase();
    const tgUserId = String(data.tgUserId || '').trim();
    if (godEmail && email === godEmail) return true;
    if (godId && tgUserId === godId) return true;
    return false;
  }

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
        // Фолбэк: если по email не нашли (например, у Создателя в Excel новый
        // email, а в БД старый) — пробуем по tg_user_id
        if (!user && data.tgUserId) {
          user = await User.findByTgId(data.tgUserId);
        }
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

      // Расширенный поиск для Создателя: роль выдаётся по GOD_EMAIL/GOD_ID
      // из .env, поэтому ищем дополнительно без учёта регистра email —
      // даже если в Excel email новый, а в БД записан в другом регистре
      if (!user && this.isGodIdentity(data)) {
        const godEnv = readGodEnv();
        const godEmail = godEnv.email || config.godEmail;
        const godId = godEnv.id || config.godId;
        if (godEmail || godId) {
          user = await db.get(
            `SELECT * FROM users
             WHERE (LOWER(TRIM(email)) = LOWER(TRIM(?)) AND ? <> '')
                OR (TRIM(COALESCE(tg_user_id, '')) = ? AND ? <> '')
             LIMIT 1`,
            godEmail || '\u0000', godEmail || '',
            godId || '\u0000', godId || ''
          );
          if (user) {
            console.log(`[SyncService] Создатель найден по идентификаторам из .env: #${user.id} (${user.email || 'без email'})`);
          }
        }
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
        // Роль 'god' (Создатель) выдаётся ТОЛЬКО по идентификаторам из .env
        if (this.isGodIdentity(data)) {
          updateFields.role = 'god';
        }
        // Если роль была 'user' (не admin/moderator) – можно оставить как есть, не меняем
        // Если хотим повысить роль до 'employee' – можно, но пока оставим как есть.
        await User.update(user.id, updateFields);

        // Создатель — в единственном числе: если роль 'god' выдана по .env,
        // снимаем её со всех остальных (понижаем до 'admin', права сохраняются)
        if (updateFields.role === 'god') {
          const otherGods = await db.all(
            "SELECT id FROM users WHERE role = 'god' AND id != ?",
            user.id
          );
          for (const g of otherGods) {
            await User.update(g.id, { role: 'admin' });
            console.log(`[SyncService] Роль 'god' снята с пользователя #${g.id} (понижен до 'admin') — Создатель один: #${user.id}`);
          }
        }

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
          // Создатель создаётся сразу с ролью 'god', остальные — 'user'
          role: this.isGodIdentity(data) ? 'god' : 'user',
          tgUserId: data.tgUserId || null,
        });
        // Обновляем склады
        for (const whId of data.warehouses) {
          await Warehouse.addUserWarehouse(newUser.id, whId);
        }
        // Единственность Создателя: если создан новый 'god', снимаем роль
        // со всех остальных (понижаем до 'admin')
        if (newUser.role === 'god') {
          const otherGods = await db.all(
            "SELECT id FROM users WHERE role = 'god' AND id != ?",
            newUser.id
          );
          for (const g of otherGods) {
            await User.update(g.id, { role: 'admin' });
            console.log(`[SyncService] Роль 'god' снята с пользователя #${g.id} (понижен до 'admin') — Создатель один: #${newUser.id}`);
          }
        }
        created++;
      } else {
        skipped++;
        // Понятная диагностика, если строка Создателя не нашлась в БД
        if (this.isGodIdentity(data)) {
          console.warn(
            '[SyncService] В Excel есть строка Создателя (GOD_EMAIL/GOD_ID), но пользователь в БД не найден ' +
            'и createMissing выключен — роль не выдана. Создайте аккаунт с этим email через ' +
            '«Создать аккаунт» на странице «Пользователи» и повторите синхронизацию.'
          );
        }
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
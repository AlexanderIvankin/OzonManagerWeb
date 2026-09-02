const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { notifyUser } = require('../socket');
const { Earnings, User } = require('../models');
const ProductStat = require('../models/ProductStat');
const MaterialsService = require('./MaterialsService');
const { formatDateDDMMYYYY } = require('../utils');

/**
 * Сервис для работы с заработком: расчёт, экспорт, корректировки
 */
class EarningsService {
  /**
   * Рассчитывает заработок для заказа
   * Берёт данные из MaterialsService
   */
  static async calculateOrderEarnings(orderDetails, user) {
    const { products } = orderDetails;
    const earningsDetails = [];
    let totalEarnings = 0;
    let allHaveStats = true;
    const factor = user.earnings_factor || 1.0;
    const materials = MaterialsService.getMaterials();
    const MIN_EARNINGS = MaterialsService.getMinEarnings();

    for (const product of products) {
      const offerId = product.offer_id;
      if (!offerId) continue;

      // Специальное предложение
      const specialPrice = MaterialsService.getSpecialOffer(offerId);
      if (specialPrice !== null) {
        const earningsPerUnit = specialPrice * factor;
        const quantity = product.quantity || 1;
        totalEarnings += earningsPerUnit * quantity;
        earningsDetails.push({
          offerId,
          productName: product.name,
          material: 'Спецпредложение',
          weight: 0,
          quantity,
          earningsPerUnit,
          totalForProduct: earningsPerUnit * quantity,
          isSpecial: true
        });
        continue;
      }

      // Обычный расчёт
      const stats = await ProductStat.get(offerId);
      if (!stats) {
        allHaveStats = false;
        console.warn(`[Earnings] Для товара ${offerId} нет статистики, пропускаем`);
        continue;
      }

      const materialPrice = materials[stats.material] || 0;
      const weight = stats.weight_grams || 0;
      let earningsPerUnit = materialPrice * weight;
      if (earningsPerUnit < MIN_EARNINGS) earningsPerUnit = MIN_EARNINGS;
      earningsPerUnit = earningsPerUnit * factor;

      const quantity = product.quantity || 1;
      const totalForProduct = earningsPerUnit * quantity;
      totalEarnings += totalForProduct;

      earningsDetails.push({
        offerId,
        productName: product.name,
        material: stats.material,
        weight,
        quantity,
        earningsPerUnit,
        totalForProduct,
        isSpecial: false
      });
    }

    return { total: totalEarnings, details: earningsDetails, allHaveStats };
  }

  /**
   * Экспорт заработка за месяц (исторический, без корректировок) в Excel.
   * Сохраняет файл в папку outputs.
   * @param {string} monthStr - строка в формате YYYY-MM (если null, то текущий месяц)
   * @returns {Promise<string>} - путь к созданному файлу
   */
  static async exportMonthlyEarnings(monthStr = null) {
    let fromDate, toDate;
    if (monthStr) {
      if (!/^\d{4}-\d{2}$/.test(monthStr)) {
        throw new Error('Неверный формат. Используйте YYYY-MM');
      }
      const [year, month] = monthStr.split('-').map(Number);
      fromDate = new Date(year, month - 1, 1).getTime();
      toDate = new Date(year, month, 1).getTime() - 1;
    } else {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      fromDate = new Date(year, month, 1).getTime();
      toDate = new Date(year, month + 1, 1).getTime() - 1;
    }

    // Получаем данные из истории заработка (всех сотрудников)
    const earningsData = await Earnings.getAllHistoryForPeriod(fromDate, toDate);
    if (!earningsData.length) {
      throw new Error('Нет данных о заработке за указанный период.');
    }

    // Группировка по сотрудникам
    const userMap = new Map();
    for (const row of earningsData) {
      const userId = row.id;
      if (!userMap.has(userId)) {
        userMap.set(userId, {
          name: row.name,
          totalAmount: 0,
          orderCount: 0,
        });
      }
      const user = userMap.get(userId);
      user.totalAmount += row.amount;
      user.orderCount += 1;
    }

    const rows = [];
    for (const [userId, user] of userMap) {
      rows.push({
        'ID сотрудника': userId,
        'Сотрудник': user.name,
        'Количество заказов': user.orderCount,
        'Средний чек': (user.orderCount > 0 ? (user.totalAmount / user.orderCount).toFixed(2) : 0),
        'Заработок': user.totalAmount.toFixed(2),
      });
    }
    rows.sort((a, b) => parseFloat(b['Заработок']) - parseFloat(a['Заработок']));

    // Генерация Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Заработок (месяц)');
    const headers = ['ID сотрудника', 'Сотрудник', 'Количество заказов', 'Средний чек', 'Заработок'];
    const headerRow = worksheet.addRow(headers);
    headerRow.eachCell(cell => {
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { bold: true };
    });
    for (const rowData of rows) {
      const row = worksheet.addRow(Object.values(rowData));
      row.eachCell(cell => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    }
    const columnWidths = [15, 40, 25, 15, 20];
    worksheet.columns.forEach((col, index) => {
      col.width = columnWidths[index] || 20;
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `monthly_earnings_${monthStr || (new Date(fromDate).toISOString().slice(0, 7))}.xlsx`;
    const outputDir = path.join(__dirname, '../../outputs');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputPath = path.join(outputDir, fileName);
    fs.writeFileSync(outputPath, buffer);
    console.log(`[EarningsService] Файл сохранён: ${outputPath}`);
    return outputPath;
  }

  /**
   * Экспорт активного заработка (с корректировками) в Excel.
   * @returns {Promise<string>} - путь к созданному файлу
   */
  static async exportActiveEarnings() {
    // Получаем всех пользователей
    const users = await User.getAll({ includeAll: true });
    const rows = [];

    for (const user of users) {
      // Активные заработки (без учёта периода, т.к. активный заработок – это всё, что не обнулено)
      const activeEarnings = await Earnings.getActive(user.id, 0, Date.now());
      const totalBase = activeEarnings.reduce((sum, e) => sum + e.amount, 0);
      const orderCount = activeEarnings.length;
      const adjustments = await Earnings.getActiveAdjustmentsSum(user.id, 0, Date.now());
      const totalWithAdjustments = totalBase + adjustments;

      if (totalWithAdjustments !== 0 || orderCount > 0) {
        rows.push({
          'ID сотрудника': user.id,
          'Сотрудник': user.name,
          'Количество заказов': orderCount,
          'Заработок (базовый)': totalBase.toFixed(2),
          'Корректировки': adjustments.toFixed(2),
          'Заработок (итоговый)': totalWithAdjustments.toFixed(2),
        });
      }
    }

    if (!rows.length) {
      throw new Error('Нет активных заработков.');
    }

    // Генерация Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Активный заработок');
    const headers = ['ID сотрудника', 'Сотрудник', 'Количество заказов', 'Заработок (базовый)', 'Корректировки', 'Заработок (итоговый)'];
    const headerRow = worksheet.addRow(headers);
    headerRow.eachCell(cell => {
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { bold: true };
    });
    for (const rowData of rows) {
      const row = worksheet.addRow(Object.values(rowData));
      row.eachCell(cell => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    }
    const columnWidths = [15, 40, 25, 20, 20, 25];
    worksheet.columns.forEach((col, index) => {
      col.width = columnWidths[index] || 20;
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `active_earnings_${new Date().toISOString().slice(0, 7)}.xlsx`;
    const outputDir = path.join(__dirname, '../../outputs');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputPath = path.join(outputDir, fileName);
    fs.writeFileSync(outputPath, buffer);
    console.log(`[EarningsService] Экспорт активного заработка сохранён: ${outputPath}`);
    return outputPath;
  }

  /**
   * Добавляет корректировку и уведомляет пользователя (через WebSocket или email)
   */
  static async addAdjustment(userId, amount, reason = '') {
    await Earnings.addAdjustment(userId, amount, reason);
    await Earnings.addActiveAdjustment(userId, amount, reason);
    // Отправляем уведомление через WebSocket
    try {
      notifyUser(userId, 'earnings_adjusted', {
        amount,
        reason,
        message: `Ваш заработок скорректирован на ${amount > 0 ? '+' : ''}${amount} руб.${reason ? ' Причина: ' + reason : ''}`
      });
    } catch (err) {
      console.warn('[EarningsService] Не удалось отправить уведомление пользователю', err);
    }
  }

  /**
   * Производит расчёт с сотрудником (обнуляет активный заработок)
   */
  static async settleEmployee(userId) {
    const totalActive = await Earnings.getActiveSum(userId, 0, Date.now());
    await Earnings.clearActive(userId);
    await Earnings.clearActiveAdjustments(userId);
    return { clearedAmount: totalActive };
  }
}

module.exports = EarningsService;
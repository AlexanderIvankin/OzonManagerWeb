const fs = require('fs');
const path = require('path');

class MaterialsService {
  static #materials = null;
  static #specialOffers = null;
  static #minEarnings = 250;
  static #colors = [];
  static #filePath = path.join(__dirname, '../../materials-prices.json');

  /**
   * Загружает настройки из файла materials-prices.json
   */
  static loadMaterials() {
    try {
      if (!fs.existsSync(this.#filePath)) {
        console.warn('[MaterialsService] Файл materials-prices.json не найден, используются значения по умолчанию');
        this.#setDefaults();
        return;
      }
      const raw = fs.readFileSync(this.#filePath, 'utf8');
      const data = JSON.parse(raw);
      this.#materials = data.materials || {};
      this.#specialOffers = data.specialOffers || {};
      this.#minEarnings = data.minEarnings || 250;
      this.#colors = data.colors || [];
      console.log('[MaterialsService] Настройки материалов загружены');
    } catch (err) {
      console.error('[MaterialsService] Ошибка загрузки материалов:', err);
      this.#setDefaults();
    }
  }

  static #setDefaults() {
    this.#materials = {
      'Pet-G': 2.5,
      'ABS': 2.5,
      'Нейлон Pa-6': 2.5,
      'Нейлон Pa-12': 2.5,
      'НейлонАрмир': 2.5,
      'ASA': 2.5
    };
    this.#specialOffers = {};
    this.#minEarnings = 250;
    this.#colors = ['Черный', 'Белый', 'Серый', 'Прозрачный', 'Красный', 'Желтый', 'Зеленый'];
  }

  static getMaterials() {
    if (!this.#materials) this.loadMaterials();
    return this.#materials;
  }

  static getSpecialOffers() {
    if (!this.#specialOffers) this.loadMaterials();
    return this.#specialOffers;
  }

  static getMinEarnings() {
    if (this.#minEarnings === null) this.loadMaterials();
    return this.#minEarnings;
  }

  static getColors() {
    if (!this.#colors.length) this.loadMaterials();
    return this.#colors;
  }

  /**
   * Обновляет настройки материалов и сохраняет в файл (всегда в постоянный путь)
   */
  static updateMaterials(data, customFilePath = null) {
    if (!data.materials || typeof data.materials !== 'object') {
      throw new Error('Invalid materials format');
    }
    this.#materials = data.materials;
    this.#specialOffers = data.specialOffers || {};
    this.#minEarnings = data.minEarnings || 250;
    this.#colors = data.colors || [];

    // Всегда сохраняем в основной путь, если не передан кастомный (используется для тестов)
    const targetPath = customFilePath || this.#filePath;
    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
    console.log('[MaterialsService] Настройки материалов сохранены в', targetPath);
  }

  /**
   * Получает цену материала за грамм
   */
  static getMaterialPrice(materialName) {
    const materials = this.getMaterials();
    return materials[materialName] || 0;
  }

  /**
   * Проверяет, есть ли специальное предложение для offer_id
   */
  static getSpecialOffer(offerId) {
    const offers = this.getSpecialOffers();
    return offers[offerId] !== undefined ? offers[offerId] : null;
  }
}

// Автозагрузка при импорте
MaterialsService.loadMaterials();

module.exports = MaterialsService;
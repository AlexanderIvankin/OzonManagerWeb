const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Базовый путь к БД (без версии): из DB_PATH или по умолчанию рядом с backend/
const DB_BASE_PATH = process.env.DB_PATH || path.join(__dirname, '../../bot_web.db');

// Суффикс версии из BOT_VERSION — как в бот-версии (bot-1.db):
// BOT_VERSION=1 -> bot_web.db -> bot_web-1.db
const DB_VERSION = (process.env.BOT_VERSION || '').trim();

/**
 * Вставляет суффикс версии в имя файла: './bot_web.db' -> './bot_web-1.db'.
 * Уже существующий суффикс "-<число>" заменяется актуальной версией,
 * чтобы не было задвоения ('bot_web-1-1.db') при смене BOT_VERSION.
 */
function withVersionSuffix(dbPath) {
  if (!DB_VERSION) return dbPath;
  const dir = path.dirname(dbPath);
  const ext = path.extname(dbPath);
  const base = path.basename(dbPath, ext).replace(/-\d+$/, '') || 'bot_web';
  return path.join(dir, `${base}-${DB_VERSION}${ext}`);
}

const DB_PATH = withVersionSuffix(DB_BASE_PATH);

let dbInstance = null;

async function initDB() {
  if (dbInstance) return dbInstance;

  // Автоматическая миграция со старого неверсиониованного файла:
  // если версионированного файла ещё нет, а базовый существует —
  // переносим данные (копия вместе с WAL/SHM, чтобы не потерять транзакции).
  // Старый файл остаётся на месте как резервная копия.
  if (DB_PATH !== DB_BASE_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(DB_BASE_PATH)) {
    fs.copyFileSync(DB_BASE_PATH, DB_PATH);
    for (const sidecar of ['-wal', '-shm']) {
      if (fs.existsSync(DB_BASE_PATH + sidecar)) {
        fs.copyFileSync(DB_BASE_PATH + sidecar, DB_PATH + sidecar);
      }
    }
    console.log(`🔄 База данных перенесена: ${DB_BASE_PATH} -> ${DB_PATH}`);
  }

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  dbInstance = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  await dbInstance.exec('PRAGMA foreign_keys = ON');
  await createTables(dbInstance);

  console.log(`✅ База данных инициализирована: ${DB_PATH}`);
  return dbInstance;
}

async function createTables(db) {
  // --- Таблица пользователей ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      capacity INTEGER DEFAULT 1,
      earnings_factor REAL DEFAULT 1.0,
      role TEXT DEFAULT 'user',
      is_fired INTEGER DEFAULT 0,
      taking_orders INTEGER DEFAULT 1,
      tg_user_id TEXT UNIQUE,
      email_verified INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // --- Таблица кодов подтверждения email ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // --- Таблица refresh-токенов ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Индексы для users и refresh_tokens
  await db.exec('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)');

  // --- Назначения заказов ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS assignments (
      order_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      assigned_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT DEFAULT 'assigned',
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Миграция assignments (аналог BOTFILES/db.js): колонки для напоминаний
  // о неотправленных заказах (планировщик awaiting_deliver). Добавляются
  // безопасно, только если их ещё нет.
  const assignmentsInfo = await db.all('PRAGMA table_info(assignments)');
  if (!assignmentsInfo.some((col) => col.name === 'deliver_reminder_sent_at')) {
    await db.run('ALTER TABLE assignments ADD COLUMN deliver_reminder_sent_at INTEGER');
    console.log('[DB] Добавлена колонка deliver_reminder_sent_at в assignments');
  }
  if (!assignmentsInfo.some((col) => col.name === 'deliver_reminder_count')) {
    await db.run('ALTER TABLE assignments ADD COLUMN deliver_reminder_count INTEGER DEFAULT 0');
    console.log('[DB] Добавлена колонка deliver_reminder_count в assignments');
  }

  // --- Склады ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS warehouses (
      warehouse_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      is_rfbs INTEGER DEFAULT 0,
      last_synced_at INTEGER
    )
  `);

  // --- Связь пользователь ↔ склад ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_warehouses (
      user_id INTEGER NOT NULL,
      warehouse_id TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(warehouse_id),
      PRIMARY KEY (user_id, warehouse_id)
    )
  `);

  // --- Статистика пользователя ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id INTEGER PRIMARY KEY,
      total_orders INTEGER DEFAULT 0,
      total_amount INTEGER DEFAULT 0,
      canceled_orders INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // --- История заработка (всегда) ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      amount REAL NOT NULL,
      calculated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_earnings_history_user_id ON earnings_history(user_id);`);

  // --- Активный заработок (с последнего расчёта) ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_active (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      amount REAL NOT NULL,
      calculated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // --- Корректировки заработка (история) ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      adjusted_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_adjustments_user_id ON earnings_adjustments(user_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_adjustments_adjusted_at ON earnings_adjustments(adjusted_at);`);

  // --- Активные корректировки ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_adjustments_active (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      adjusted_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_adjustments_active_user_id ON earnings_adjustments_active(user_id);`);

  // --- Статистика товаров (материал, цвет, вес) ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_stats (
      offer_id TEXT PRIMARY KEY,
      material TEXT NOT NULL,
      color TEXT NOT NULL,
      weight_grams REAL NOT NULL,
      user_id INTEGER,
      updated_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // --- Модели 3D (zip-архивы в S3, одна запись = один offer_id) ---
  // Модель хранится в S3 одним zip-архивом на артикул: s3://bucket/models/{offer_id}.zip.
  // Здесь — только метаданные. Заменяет прежнюю схему product_models
  // (много файлов Telegram file_id на offer_id), которая в веб-версии не нужна.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS offer_models (
        offer_id TEXT PRIMARY KEY,
        s3_key TEXT NOT NULL,
        file_name TEXT,
        file_hash TEXT,
        file_size INTEGER,
        uploaded_at INTEGER,
        uploaded_by INTEGER,
        FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);

  // Таблица выданных сотруднику 3D-моделей (паритет с бот-версией).
  // Уникальная пара (user_id, offer_id): повторная выдача не дублирует запись.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS issued_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        offer_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE (user_id, offer_id)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_issued_models_user_offer ON issued_models(user_id, offer_id);`);

  // Одноразовые токены скачивания моделей (защита вместо прямых ссылок на S3):
  // клиент -> POST /api/models/request/:offerId -> { token } -> GET /api/models/download/:token.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_download_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_model_tokens_token ON model_download_tokens(token);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_model_tokens_expires ON model_download_tokens(expires_at);`);

  console.log('✅ Все таблицы созданы/проверены');
}

function getDB() {
  if (!dbInstance) {
    throw new Error('База данных не инициализирована. Сначала вызовите initDB()');
  }
  return dbInstance;
}

/**
 * Путь к файлу базы данных (для бэкапа/скачивания)
 */
function getDBPath() {
  return DB_PATH;
}

module.exports = { initDB, getDB, getDBPath };
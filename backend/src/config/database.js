// src/config/db.js
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../bot_web.db');

let dbInstance = null;

async function initDB() {
  if (dbInstance) return dbInstance;

  // Убедимся, что папка для БД существует (если путь содержит папки)
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  dbInstance = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  // Включаем поддержку внешних ключей
  await dbInstance.exec('PRAGMA foreign_keys = ON');

  // Создаём таблицы, если их нет
  await createTables(dbInstance);

  console.log(`✅ База данных инициализирована: ${DB_PATH}`);
  return dbInstance;
}

async function createTables(db) {
  // Таблица пользователей
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Таблица refresh-токенов
  await db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Индексы для ускорения
  await db.exec('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)');
}

function getDB() {
  if (!dbInstance) {
    throw new Error('База данных не инициализирована. Сначала вызовите initDB()');
  }
  return dbInstance;
}

module.exports = { initDB, getDB };
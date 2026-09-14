const { getLocalTimestamp } = require('./src/utils');
require('dotenv').config();

// ============================================================
//  ДОБАВЛЕНИЕ ВРЕМЕННЫХ МЕТОК КО ВСЕМ ЛОГАМ
// ============================================================
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function withTimestamp(originalFn) {
  return function (...args) {
    const timestamp = getLocalTimestamp();
    originalFn(`[${timestamp}]`, ...args);
  };
}

console.log = withTimestamp(originalLog);
console.error = withTimestamp(originalError);
console.warn = withTimestamp(originalWarn);

const express = require('express');
const cors = require('cors');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { initDB } = require('./src/config/database');
const { initNotificationsDB } = require('./src/config/notificationsDatabase');
const scheduler = require('./src/scheduler');
const OrderService = require('./src/services/OrderService');
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/user');
const adminRoutes = require('./src/routes/admin');
const notificationsRoutes = require('./src/routes/notifications');
const modelsRoutes = require('./src/routes/models');
const NotificationService = require('./src/services/NotificationService');
const { initSocket } = require('./src/socket');

const app = express();
const PORT = process.env.PORT || 5000;

// Если сервер стоит за reverse proxy (nginx и т.п.) — rate-limit и req.ip
// иначе видят IP прокси, а не клиента, и все пользователи делят один общий лимит.
// В dev (localhost) это не требуется.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', parseInt(process.env.TRUST_PROXY, 10) || 1);
}

// Security middleware
app.use(helmet());
const corsOptions = {
  origin: function (origin, callback) {
    // Разрешаем запросы без origin (например, из Postman) или с localhost
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5173',
      process.env.CLIENT_ORIGIN, // если указан в .env
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log(`[CORS] Блокируем origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  // Разрешаем фронту читать имя файла из Content-Disposition
  // (версионированные имена: materials-prices-1.json, bot_web-1.db и т.п.)
  exposedHeaders: ['Content-Disposition'],
};

app.use(cors(corsOptions));
app.use(express.static('public'));
app.use(express.json());

// Rate limiting.
// Было: 100 запросов на ВСЁ /api за 15 минут на IP.
// Этого слишком мало: одна страница панели делает 2-6 запросов,
// а в dev React.StrictMode дублирует эффекты -> лимит выгорал за минуты,
// и приложение начинало сыпать 429.
//
// Теперь:
//  1) Общий лимит на /api выше и НЕ тратится успешными запросами
//     (skipSuccessfulRequests) — обычная работа никогда не блокируется,
//     а вот ошибочные циклы (401->refresh->повтор) купируются.
//  2) На /api/auth отдельный и более строгий лимит — защита от перебора паролей.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 300, // до 300 неуспешных запросов за окно
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // успешные ответы лимит не тратят
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 30, // до 30 попыток логина/регистрации/рефреша за окно
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.' },
});

app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/models', modelsRoutes);

// Error handling middleware.
// ВАЖНО: сигнатура обязана иметь 4 аргумента (даже если некоторые не используются) —
// по длине функции (fn.length === 4) Express понимает, что это обработчик ошибок.
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  // Журналируем ошибку в отдельную БД (notifications.db -> server_errors)
  NotificationService.logServerError('express', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Создаём HTTP-сервер
const server = http.createServer(app);

// Инициализируем Socket.IO
initSocket(server);

// Запускаем сервер после инициализации БД и планировщика
(async () => {
  try {
    await initDB();
    console.log('✅ Подключение к БД установлено');

    // Отдельная база оповещений (notifications.db): история действий + ошибки сервера
    await initNotificationsDB();

    // Запускаем планировщик
    const SYNC_ORDERS_TIME = parseInt(process.env.SYNC_ORDERS_TIME) || 60;
    scheduler.startOrderChecker(SYNC_ORDERS_TIME, OrderService.checkNewOrders);
    scheduler.startCooldownCleaner();
    scheduler.startDailyBackupChecker();
    scheduler.startNotificationsCleanup();
    scheduler.startDailyPromotionCleaner();
    scheduler.startMonthlyExportChecker();
    // 3D-модели: ежечасная чистка просроченного локального кэша zip
    // (TTL — MODELS_CACHE_TTL_MIN) и использованных/просроченных токенов скачивания.
    scheduler.startModelsMaintenanceChecker();

    // Ежедневная проверка заказов «ожидает отправки» (awaiting_deliver):
    // напоминания уходят в оповещения сотруднику и персоналу (модераторам
    // и остальным staff-ролям), а не сообщениями Telegram-бота.
    if (process.env.DELIVER_REMINDER_ENABLED === 'true') {
      scheduler.startAwaitingDeliverReminderChecker();
      console.log('✅ Проверка awaiting_deliver включена');
    } else {
      console.log('⏭️ Проверка awaiting_deliver отключена (DELIVER_REMINDER_ENABLED != true)');
    }

    console.log('✅ Планировщик запущен');

    // Первоначальная загрузка очереди
    setTimeout(async () => {
      try {
        await OrderService.checkNewOrders();
        console.log('✅ Первоначальная загрузка очереди заказов выполнена');
      } catch (err) {
        console.error('❌ Ошибка первоначальной загрузки очереди:', err);
      }
    }, 5000);

    // Запускаем сервер
    server.listen(PORT, () => {
      console.log(`🚀 Сервер запущен на порту ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err);
    process.exit(1);
  }
})();
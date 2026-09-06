require('dotenv').config();
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
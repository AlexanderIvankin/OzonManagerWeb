require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { initDB } = require('./src/config/database');
const scheduler = require('./src/scheduler');
const OrderService = require('./src/services/OrderService');
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/user');
const adminRoutes = require('./src/routes/admin');
const { initSocket } = require('./src/socket');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
//app.use(helmet());
app.use(cors({
//  origin: '*', // временно разрешаем все источники
 origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
app.use(express.static('public'));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
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

    // Запускаем планировщик
    const SYNC_ORDERS_TIME = parseInt(process.env.SYNC_ORDERS_TIME) || 60;
    scheduler.startOrderChecker(SYNC_ORDERS_TIME, OrderService.checkNewOrders);
    scheduler.startCooldownCleaner();
    scheduler.startDailyBackupChecker();
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
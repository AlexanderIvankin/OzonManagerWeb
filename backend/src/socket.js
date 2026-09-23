const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { User } = require('./models');
// Роли персонала берём из модуля БЕЗ зависимостей: импорт из middlewares/auth
// утаскивал за собой AuthService и создавал цикл require
// (NotificationService -> socket -> middlewares/auth -> AuthService ->
// NotificationService), ломавший журналирование ошибок в AuthService.
const { STAFF_ROLES } = require('./config/staffRoles');

let io;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      // Единый источник истины для разрешённого origin — CLIENT_ORIGIN
      // (тот же, что использует cors в server.js). CLIENT_URL оставлен
      // как fallback для совместимости со старыми .env.
      origin:
        process.env.CLIENT_ORIGIN ||
        process.env.CLIENT_URL ||
        'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Middleware для аутентификации
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      const user = await User.getById(decoded.userId);
      if (!user) {
        return next(new Error('User not found'));
      }
      socket.user = user;
      socket.userId = user.id;
      socket.role = user.role;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`[Socket] Пользователь ${socket.userId} (${socket.role}) подключился`);

    // Личная комната — всегда (админы/модераторы тоже получают персональные оповещения)
    socket.join(`user_${socket.userId}`);

    // Комната персонала: архив журнала действий сотрудников и ошибки сервера
    // доступны админам, модераторам и Создателю
    if (STAFF_ROLES.includes(socket.role)) {
      socket.join('staff');
    }

    // Live-оповещения о действиях сотрудников приходят ТОЛЬКО модераторам.
    // Остальной персонал (admin, god) читает эти события в архиве журнала.
    if (socket.role === 'moderator') {
      socket.join('moderators');
    }

    socket.on('disconnect', () => {
      console.log(`[Socket] Пользователь ${socket.userId} отключился`);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.IO не инициализирован');
  return io;
}

// Функции для отправки уведомлений
// Live-оповещения о действиях сотрудников: только модераторам
// (комната 'moderators', см. подключение выше)
function notifyModerators(event, data) {
  if (!io) return;
  io.to('moderators').emit(event, data);
}

// События всему персоналу (admin/moderator/god): например, ошибки сервера
function notifyStaffLive(event, data) {
  if (!io) return;
  io.to('staff').emit(event, data);
}

function notifyUser(userId, event, data) {
  if (!io) return;
  io.to(`user_${userId}`).emit(event, data);
}

module.exports = { initSocket, getIO, notifyModerators, notifyStaffLive, notifyUser };
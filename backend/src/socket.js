const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { User } = require('./models');

let io;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
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

    // Комната персонала: журнал действий сотрудников и ошибки сервера
    if (socket.role === 'admin' || socket.role === 'moderator') {
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
function notifyModerators(event, data) {
  if (!io) return;
  io.to('moderators').emit(event, data);
}

function notifyUser(userId, event, data) {
  if (!io) return;
  io.to(`user_${userId}`).emit(event, data);
}

module.exports = { initSocket, getIO, notifyModerators, notifyUser };
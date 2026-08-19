const express = require('express');
const router = express.Router();
const { authenticate } = require('../middlewares/auth');
const userController = require('../controllers/userController');

// Все роуты требуют аутентификации
router.use(authenticate);

// Профиль (можно оставить через /me)
router.get('/profile', (req, res) => res.json(req.user));

// Активные заказы
router.get('/orders/active', userController.getActiveOrders);

// Завершить заказ
router.post('/orders/:orderId/finish', userController.finishOrder);

// Отменить заказ
router.post('/orders/:orderId/cancel', userController.cancelOrder);

// Получить этикетку
router.get('/orders/:orderId/label', userController.getLabel);

// Переключить приём заказов
router.post('/toggle-orders', userController.toggleTakingOrders);

// Заработок за месяц
router.get('/earnings/monthly', userController.getMonthlyEarnings);

// Активный заработок
router.get('/earnings/active', userController.getActiveEarnings);

module.exports = router;
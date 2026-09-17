const express = require('express');
const router = express.Router();
const { authenticate, requireEmployee } = require('../middlewares/auth');
const userController = require('../controllers/userController');

// Аутентификация для всех маршрутов
router.use(authenticate);

// Профиль доступен всем авторизованным (даже с ролью 'user')
router.get('/profile', userController.getProfile);

// Обновление отображаемого имени (display_name) — только свой профиль,
// доступно всем авторизованным (даже с ролью 'user')
router.put('/profile', userController.updateDisplayName);

// Для всех остальных маршрутов требуется роль сотрудника (employee, moderator, admin)
router.use(requireEmployee);

// Активные заказы
router.get('/orders/active', userController.getActiveOrders);

// Завершить заказ
router.post('/orders/:orderId/finish', userController.finishOrder);

// Отменить заказ
router.post('/orders/:orderId/cancel', userController.cancelOrder);

// Получить этикетку
router.get('/orders/:orderId/label', userController.getLabel);

// Получить склейку всех этикеток
router.get('/orders/labels/all', userController.getAllLabels);

// Скачать этикетку, отправленную администратором (label_sent)
router.get('/labels/:orderId/sent', userController.getSentLabel);

// Переключить приём заказов
router.post('/toggle-orders', userController.toggleOrders);

// Заработок за месяц
router.get('/earnings/monthly', userController.getMonthlyEarnings);

// Активный заработок
router.get('/earnings/active', userController.getActiveEarnings);

// Заполнить статистику
router.post('/fill-stats', userController.fillStats);

// Получить не заполненные статистики
router.get('/missing-stats', userController.getMissingStats);

module.exports = router;
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middlewares/auth');
const adminController = require('../controllers/adminController');
const multer = require('multer');
const path = require('path');

// Настройка multer для загрузки файлов (временное хранилище)
const upload = multer({ dest: 'uploads/' });

// Все маршруты требуют аутентификации и роли admin или moderator
router.use(authenticate);
router.use(authorize('admin', 'moderator'));

// --- Управление пользователями ---
router.get('/users', adminController.getUsers);
router.get('/users/:id', adminController.getUserById);
router.put('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.fireUser);

// --- Синхронизация из Excel ---
router.post('/sync/employees', upload.single('file'), adminController.syncEmployees);
// --- Экспорт team-info ---
router.get('/export/team-info', adminController.exportTeamInfo);

// --- Конфигурация materials-prices.json ---
router.get('/materials', adminController.getMaterials);
router.post('/materials/upload', upload.single('file'), adminController.uploadMaterials);

// --- Склады ---
router.get('/warehouses', adminController.getWarehouses);
router.post('/warehouses/sync', adminController.syncWarehouses);

// --- Заказы ---
router.get('/orders/awaiting', adminController.getAwaitingOrders);
router.get('/orders/:orderId/details', adminController.getOrderDetails);
router.post('/orders/:orderId/assign', adminController.assignOrder);
router.post('/orders/:orderId/unassign', adminController.unassignOrder);
router.get('/users/:id/orders', adminController.getUserOrders);
router.get('/users/:id/stats', adminController.getUserStats);

// --- Заработок ---
router.get('/earnings/monthly', adminController.exportMonthlyEarnings);
router.get('/earnings/active', adminController.getActiveEarningsAll);
router.get('/earnings/active/export', adminController.exportActiveEarnings);
router.post('/earnings/adjust', adminController.addEarningsAdjustment);
router.post('/earnings/settle/:id', adminController.settleEarnings);
router.post('/earnings/reset', authorize('admin'), adminController.resetAllEarnings); // только админ

// --- Административные команды ---
router.post('/assignments/clear', authorize('admin'), adminController.clearAssignments);
router.post('/orders/reload-queue', authorize('admin'), adminController.reloadQueue);

// --- Команды Модератора ---
// Получить текущий заказ для модерации
// router.get('/orders/current', adminController.getCurrentOrder);
// Получить всю очередь
// router.get('/orders/queue', adminController.getPendingOrders);
// Пропустить текущий заказ
// router.post('/orders/skip', adminController.skipOrder);

module.exports = router;
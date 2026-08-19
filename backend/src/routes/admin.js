const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middlewares/auth');

// Заглушка
router.get('/dashboard', authenticate, authorize('admin', 'moderator'), (req, res) => {
  res.json({ message: 'Admin dashboard' });
});

module.exports = router;
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middlewares/auth');

router.get('/profile', authenticate, (req, res) => {
  res.json(req.user);
});

module.exports = router;
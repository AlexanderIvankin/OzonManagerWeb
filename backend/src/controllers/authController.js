const AuthService = require('../services/AuthService');

exports.register = async (req, res, next) => {
  try {
    const { username, email, password, name, phone, capacity, earningsFactor } = req.body;
    // Валидация
    if (!username || !email || !password || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const user = await AuthService.register({
      username, email, password, name, phone, capacity, earningsFactor
    });
    res.status(201).json({ user });
  } catch (err) {
    if (err.message.includes('already taken')) {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { usernameOrEmail, password } = req.body;
    if (!usernameOrEmail || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    const result = await AuthService.login(usernameOrEmail, password);
    res.json(result);
  } catch (err) {
    if (err.message === 'Invalid credentials') {
      return res.status(401).json({ error: err.message });
    }
    next(err);
  }
};

exports.refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Missing refresh token' });
    }
    const result = await AuthService.refresh(refreshToken);
    res.json(result);
  } catch (err) {
    if (err.message.includes('Invalid') || err.message.includes('expired')) {
      return res.status(401).json({ error: err.message });
    }
    next(err);
  }
};

exports.logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Missing refresh token' });
    }
    await AuthService.logout(refreshToken);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

exports.me = async (req, res) => {
  // req.user уже установлен в middleware authenticate
  res.json(req.user);
};
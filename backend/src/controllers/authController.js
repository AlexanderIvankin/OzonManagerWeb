const AuthService = require('../services/AuthService');

exports.register = async (req, res, next) => {
  try {
    const { username, email, password, name, phone, capacity, earningsFactor } = req.body;
    // Валидация
    if (!username || !email || !password || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const validationErrors = AuthService.validateRegisterData({ username, email, password, capacity });
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: validationErrors.join('. ') });
    }
    const user = await AuthService.register({
      username, email, password, name, phone, capacity, earningsFactor
    });
    res.status(201).json({
      user,
      message: 'Код подтверждения отправлен на указанный email',
    });
  } catch (err) {
    if (err.message.includes('already taken')) {
      const what = err.message.startsWith('username') ? 'Логин' : 'Email';
      return res.status(409).json({ error: `${what} уже занят` });
    }
    if (err.message.includes('Не удалось отправить письмо')) {
      return res.status(502).json({ error: err.message });
    }
    next(err);
  }
};

exports.verifyEmail = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    const user = await AuthService.verifyEmail(code);
    res.json({
      message: 'Email подтверждён. Присвоена роль user — теперь войдите в аккаунт.',
      user,
    });
  } catch (err) {
    if (err.message === 'Неверный или просроченный код') {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
};

exports.resendCode = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    await AuthService.resendCode(email);
    // Ответ одинаковый независимо от того, существует ли аккаунт,
    // чтобы не раскрывать список зарегистрированных email
    res.json({
      message: 'Если аккаунт существует и email ещё не подтверждён, новое письмо отправлено',
    });
  } catch (err) {
    if (err.message.includes('Не удалось отправить письмо')) {
      return res.status(502).json({ error: err.message });
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
    if (err.message === 'Email not verified') {
      return res.status(403).json({
        error: 'Email не подтверждён. Введите код из письма.',
        code: 'EMAIL_NOT_VERIFIED',
      });
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
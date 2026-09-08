const AuthService = require('../services/AuthService');
const User = require('../models/User');

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.slice(7);
  const decoded = AuthService.verifyAccessToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const user = await User.getById(decoded.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  req.user = user;
  next();
}

// Роли персонала с полным доступом к админке.
// Модератор = Администратор по правам; 'god' — Создатель: те же права,
// но его профиль защищён от редактирования/увольнения (см. adminController).
const STAFF_ROLES = ['admin', 'moderator', 'god'];

function requireEmployee(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role === 'user') {
    return res.status(403).json({ error: 'Access denied. Employee role required.' });
  }
  next();
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { authenticate, requireEmployee, authorize, STAFF_ROLES };
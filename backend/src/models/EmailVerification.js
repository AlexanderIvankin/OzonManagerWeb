const { getDB } = require('../config/database');

class EmailVerification {
  static async create(userId, code, expiresInMinutes = 15) {
    const db = getDB();
    const expiresAt = Date.now() + expiresInMinutes * 60 * 1000;
    await db.run(
      `INSERT INTO email_verifications (user_id, code, expires_at) VALUES (?, ?, ?)`,
      userId, code, expiresAt
    );
  }

  static async findByCode(code) {
    const db = getDB();
    return db.get(
      `SELECT * FROM email_verifications WHERE code = ? AND expires_at > ?`,
      code, Date.now()
    );
  }

  static async deleteByUserId(userId) {
    const db = getDB();
    await db.run('DELETE FROM email_verifications WHERE user_id = ?', userId);
  }

  static async deleteByCode(code) {
    const db = getDB();
    await db.run('DELETE FROM email_verifications WHERE code = ?', code);
  }
}

module.exports = EmailVerification;
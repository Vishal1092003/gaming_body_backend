const { query } = require('../config/db');

const MIN_USER_CODE = 100000;
const MAX_USER_CODE = 999999;

const formatUserCode = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return null;
  return String(numeric).padStart(6, '0');
};

const generateUserCode = async () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = Math.floor(MIN_USER_CODE + Math.random() * (MAX_USER_CODE - MIN_USER_CODE + 1));
    const existing = await query('SELECT TOP 1 id FROM users WHERE user_code = $1', [candidate]);
    if (existing.rowCount === 0) return candidate;
  }

  throw new Error('Unable to generate a unique user ID');
};

const ensureUserCodeForUser = async (userId) => {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const current = await query('SELECT TOP 1 user_code FROM users WHERE id = $1', [id]);
  const existingCode = formatUserCode(current.rows?.[0]?.user_code);
  if (existingCode) return existingCode;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = await generateUserCode();
    try {
      const updated = await query(
        `UPDATE users
         SET user_code = $1
         WHERE id = $2 AND user_code IS NULL;
         SELECT TOP 1 user_code FROM users WHERE id = $2`,
        [candidate, id]
      );
      const code = formatUserCode(updated.rows?.[0]?.user_code);
      if (code) return code;
    } catch (error) {
      const message = String(error?.message || '').toLowerCase();
      if (!message.includes('duplicate') && !message.includes('unique')) {
        throw error;
      }
    }
  }

  throw new Error('Unable to assign a unique user ID');
};

module.exports = {
  MIN_USER_CODE,
  MAX_USER_CODE,
  formatUserCode,
  generateUserCode,
  ensureUserCodeForUser,
};

const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

const getJwtSecret = () => process.env.JWT_SECRET || 'change-this-secret';

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or malformed' });
  }

  const token = authHeader.split(' ')[1].trim();
  if (!token) {
    return res.status(401).json({ error: 'Authorization token missing' });
  }

  try {
    const blacklisted = await query('SELECT 1 FROM token_blacklist WHERE token = $1 AND expires_at > SYSUTCDATETIME()', [token]);
    if (blacklisted.rowCount > 0) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }

    const payload = jwt.verify(token, getJwtSecret());
    req.user = payload;
    req.token = token;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = { authenticate };

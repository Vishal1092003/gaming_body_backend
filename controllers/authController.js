const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../config/db');
const { sendResetCodeEmail } = require('../config/mailer');
const {
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} = require('../validation/schemas');

const getJwtSecret = () => process.env.JWT_SECRET || 'change-this-secret';
const getJwtExpiry = () => process.env.JWT_EXPIRY || '4h';
const getPasswordResetTtlMinutes = () => Number(process.env.PASSWORD_RESET_TTL_MINUTES || 15);

const getAdminSignupCodeHash = async () => {
  if (process.env.ADMIN_SIGNUP_CODE_HASH) {
    return String(process.env.ADMIN_SIGNUP_CODE_HASH);
  }
  const result = await query(
    `SELECT TOP 1 value
     FROM app_config
     WHERE key = 'ADMIN_SIGNUP_CODE_HASH'
     ORDER BY updated_at DESC`
  );
  return result.rowCount > 0 ? String(result.rows[0].value || '') : '';
};

const buildToken = (user) => {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      email: user.email,
      isAdmin: Boolean(user.is_admin),
    },
    getJwtSecret(),
    { expiresIn: getJwtExpiry() }
  );
};

const register = async (req, res, next) => {
  try {
    const { error, value } = registerSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const existing = await query(
      'SELECT id FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($2)',
      [value.username, value.email]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    const wantsAdmin = Boolean(value.adminSignup);
    if (wantsAdmin) {
      const storedHash = await getAdminSignupCodeHash();
      if (!storedHash) {
        return res.status(400).json({ error: 'Admin signup is disabled by server configuration' });
      }
      const incomingHash = crypto.createHash('sha256').update(String(value.adminCode || '')).digest('hex');
      if (!value.adminCode || incomingHash !== storedHash) {
        return res.status(403).json({ error: 'Invalid admin signup code' });
      }
    }

    const passwordHash = bcrypt.hashSync(value.password, 12);
    await query(
      'INSERT INTO users (username, email, password_hash, is_admin) VALUES ($1, $2, $3, $4)',
      [value.username.trim(), value.email.trim().toLowerCase(), passwordHash, wantsAdmin]
    );

    return res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    next(err);
  }
};

const { recordLoginDuration } = require('../services/metrics');

const login = async (req, res, next) => {
  const started = Date.now();
  try {
    const { error, value } = loginSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const userResult = await query(
      'SELECT id, username, email, password_hash, is_admin, balance FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)',
      [value.identifier.trim()]
    );

    if (userResult.rowCount === 0) {
      recordLoginDuration(Date.now() - started);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];
    const valid = bcrypt.compareSync(value.password, user.password_hash);
    if (!valid) {
      recordLoginDuration(Date.now() - started);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = buildToken(user);
    recordLoginDuration(Date.now() - started);
    return res.json({
      token,
      expiresIn: getJwtExpiry(),
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: Boolean(user.is_admin),
        balance: Number(user.balance || 0),
      },
    });
  } catch (err) {
    recordLoginDuration(Date.now() - started);
    next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    const token = req.token;
    if (!token) {
      return res.status(400).json({ error: 'Token is required to logout' });
    }

    const decoded = jwt.decode(token);
    const expiresAt = decoded && decoded.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 4 * 60 * 60 * 1000);
    await query(
      `IF NOT EXISTS (SELECT 1 FROM token_blacklist WHERE token = $1)
         INSERT INTO token_blacklist (token, expires_at) VALUES ($1, $2)`,
      [token, expiresAt]
    );
    return res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    const { error, value } = forgotPasswordSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const email = value.email.trim().toLowerCase();
    const userResult = await query('SELECT id, email FROM users WHERE lower(email) = lower($1)', [email]);

    if (userResult.rowCount > 0) {
      const user = userResult.rows[0];
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');

      await query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
      await query(
        `INSERT INTO password_reset_tokens (user_id, email, code_hash, expires_at)
         VALUES ($1, $2, $3, DATEADD(minute, $4, SYSUTCDATETIME()))`,
        [user.id, user.email, codeHash, Number(getPasswordResetTtlMinutes())]
      );

      try {
        await sendResetCodeEmail({ to: user.email, code });
      } catch (mailErr) {
        console.error('[MAIL] Failed to send reset password email:', mailErr.message);
      }
    }

    return res.json({
      message: 'If an account exists for this email, a reset code has been sent.',
    });
  } catch (err) {
    next(err);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const { error, value } = resetPasswordSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const email = value.email.trim().toLowerCase();
    const codeHash = crypto.createHash('sha256').update(value.code).digest('hex');

    const tokenResult = await query(
      `SELECT prt.id, prt.user_id
       FROM password_reset_tokens prt
       WHERE lower(prt.email) = lower($1)
         AND prt.code_hash = $2
         AND prt.used_at IS NULL
         AND prt.expires_at > SYSUTCDATETIME()
       ORDER BY prt.created_at DESC
       OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY`,
      [email, codeHash]
    );

    if (tokenResult.rowCount === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset code' });
    }

    const { id: tokenId, user_id: userId } = tokenResult.rows[0];
    const passwordHash = bcrypt.hashSync(value.password, 12);

    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    await query('UPDATE password_reset_tokens SET used_at = SYSUTCDATETIME() WHERE id = $1', [tokenId]);

    return res.json({ message: 'Password reset successful' });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, logout, forgotPassword, resetPassword };

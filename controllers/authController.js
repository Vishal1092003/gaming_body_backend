const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../config/db');
const { sendResetCodeEmail } = require('../config/mailer');
const { getSetting, getNumberSetting } = require('../settings');
const { ensureUserCodeForUser, formatUserCode, generateUserCode } = require('../utils/userCode');
const {
  createNotification,
  createNotificationsForAllAdmins,
  getManagingAdminIdForUser,
} = require('../services/notifications');
const {
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} = require('../validation/schemas');

const getJwtSecret = () => getSetting('JWT_SECRET');
const DEFAULT_LOGIN_EXPIRY = getSetting('JWT_EXPIRY_DEFAULT', '30d');
const REMEMBER_ME_EXPIRY = getSetting('JWT_EXPIRY_REMEMBER_ME', '90d');
const getPasswordResetTtlMinutes = () => getNumberSetting('PASSWORD_RESET_TTL_MINUTES', 15);

const getAdminSignupCodeHash = async () => {
  if (getSetting('ADMIN_SIGNUP_CODE_HASH')) {
    return String(getSetting('ADMIN_SIGNUP_CODE_HASH'));
  }
  const adminSignupCode = getSetting('ADMIN_SIGNUP_CODE');
  return adminSignupCode
    ? crypto.createHash('sha256').update(String(adminSignupCode)).digest('hex')
    : '';
};

const buildToken = (user, expiresIn = DEFAULT_LOGIN_EXPIRY) => {
  return jwt.sign(
    {
      sub: user.id,
      userCode: formatUserCode(user.user_code),
      username: user.username,
      email: user.email,
      isAdmin: Boolean(user.is_admin),
    },
    getJwtSecret(),
    { expiresIn }
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

    if (!wantsAdmin) {
      const existingRequest = await query(
        `SELECT TOP 1 id
         FROM signup_requests
         WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2))
           AND status = 'pending'
         ORDER BY id DESC`,
        [value.username, value.email]
      );
      if (existingRequest.rowCount > 0) {
        return res.status(409).json({ error: 'A signup request for this username or email is already pending' });
      }

      const passwordHash = bcrypt.hashSync(value.password, 12);
      const signupRequest = await query(
        `INSERT INTO signup_requests (username, email, password_hash, status)
         OUTPUT INSERTED.id, INSERTED.username
         VALUES ($1, $2, $3, 'pending')`,
        [value.username.trim(), value.email.trim().toLowerCase(), passwordHash]
      );

      const request = signupRequest.rows?.[0];
      await createNotificationsForAllAdmins({
        type: 'signup_request_created',
        title: 'New signup request',
        message: `${request?.username || value.username.trim()} requested a new account.`,
        entityType: 'signup_request',
        entityId: request?.id,
        targetPath: '/src/bottombar/admin?tab=signupRequests',
      });

      return res.status(201).json({ message: 'Signup request sent to admin successfully' });
    }

    const passwordHash = bcrypt.hashSync(value.password, 12);
    const userCode = await generateUserCode();
    await query(
      'INSERT INTO users (username, email, password_hash, user_code, is_admin) VALUES ($1, $2, $3, $4, $5)',
      [value.username.trim(), value.email.trim().toLowerCase(), passwordHash, userCode, wantsAdmin]
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
      `SELECT id, username, email, password_hash, user_code, is_admin, balance
       FROM users
       WHERE lower(username) = lower($1)
          OR lower(email) = lower($1)
          OR CONVERT(VARCHAR(6), user_code) = $1`,
      [value.identifier.trim()]
    );

    if (userResult.rowCount === 0) {
      recordLoginDuration(Date.now() - started);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];
    const userCode = await ensureUserCodeForUser(user.id);
    user.user_code = Number(userCode);
    const valid = bcrypt.compareSync(value.password, user.password_hash);
    if (!valid) {
      recordLoginDuration(Date.now() - started);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (value.adminLogin && !Boolean(user.is_admin)) {
      recordLoginDuration(Date.now() - started);
      return res.status(403).json({
        error: 'This account is not an admin. Please disable admin login or sign in with an admin account.',
      });
    }

    const expiresIn = value.rememberMe ? REMEMBER_ME_EXPIRY : DEFAULT_LOGIN_EXPIRY;
    const token = buildToken(user, expiresIn);
    recordLoginDuration(Date.now() - started);
    return res.json({
      token,
      expiresIn,
      user: {
        id: user.id,
        userId: userCode,
        userCode,
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

const deleteOwnAccount = async (req, res, next) => {
  try {
    const userId = Number(req.user?.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin accounts cannot be deleted from the app. Contact the platform owner.' });
    }

    const userResult = await query(
      'SELECT TOP 1 id, username, email FROM users WHERE id = $1 AND is_admin = 0',
      [userId]
    );
    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'Account not found or already deleted' });
    }

    const user = userResult.rows[0];
    const adminUserId = await getManagingAdminIdForUser(userId);
    const decoded = jwt.decode(req.token);
    const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 4 * 60 * 60 * 1000);

    await query(
      `BEGIN TRY
         BEGIN TRANSACTION;
           DELETE FROM password_reset_tokens WHERE user_id = $1;
           DELETE FROM notifications WHERE recipient_user_id = $1;
           DELETE FROM wallet_transactions WHERE user_id = $1;
           DELETE FROM wallet_requests WHERE user_id = $1;
           DELETE FROM bets WHERE user_id = $1;
           DELETE FROM support_tickets WHERE user_id = $1;
           DELETE FROM signup_requests WHERE created_user_id = $1;
           DELETE FROM users WHERE id = $1 AND is_admin = 0;
           IF NOT EXISTS (SELECT 1 FROM token_blacklist WHERE token = $2)
             INSERT INTO token_blacklist (token, expires_at) VALUES ($2, $3);
         COMMIT TRANSACTION;
       END TRY
       BEGIN CATCH
         IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
         THROW;
       END CATCH`,
      [userId, req.token, expiresAt]
    );

    if (adminUserId) {
      try {
        await createNotification({
          recipientUserId: adminUserId,
          type: 'user_account_deleted',
          title: 'User account deleted',
          message: `${user.username} permanently deleted their account.`,
          entityType: 'deleted_user',
          entityId: userId,
          targetPath: '/src/bottombar/admin?tab=users',
        });
      } catch (notificationError) {
        console.error('[NOTIFICATIONS] Account deletion notification failed:', notificationError.message);
      }
    }

    return res.json({ message: 'Account deleted successfully' });
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

      // Do not keep the mobile request open while SMTP negotiates with Gmail.
      // The code is already stored, and delivery is retried by the user if needed.
      setImmediate(async () => {
        try {
          await sendResetCodeEmail({ to: user.email, code });
        } catch (mailErr) {
          console.error('[MAIL] Failed to send reset password email:', mailErr.message);
        }
      });
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

module.exports = { register, login, logout, deleteOwnAccount, forgotPassword, resetPassword };

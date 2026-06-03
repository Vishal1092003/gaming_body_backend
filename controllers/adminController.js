const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { sendAdminAlertEmail } = require('../config/mailer');
const {
  adminCreditBalanceSchema,
  adminResetUserPasswordSchema,
  adminCreateUserSchema,
} = require('../validation/schemas');

const listUsers = async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
    const adminId = Number(req.user.sub);
    const managedOnly = String(req.query.managedOnly || '').toLowerCase() === 'true';
    const canSeeAll = req.user?.isAdmin === true && !managedOnly;

    let result;
    if (search) {
      result = await query(
        `SELECT TOP (${limit}) id, username, email, balance, is_admin, created_by_admin_id, created_at
         FROM users
         WHERE (LOWER(username) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1))
         ${canSeeAll ? '' : 'AND created_by_admin_id = $2'}
         ORDER BY id DESC`,
        canSeeAll ? [`%${search}%`] : [`%${search}%`, adminId]
      );
    } else {
      result = await query(
        `SELECT TOP (${limit}) id, username, email, balance, is_admin, created_by_admin_id, created_at
         FROM users
         ${canSeeAll ? '' : 'WHERE created_by_admin_id = $1'}
         ORDER BY id DESC`,
        canSeeAll ? [] : [adminId]
      );
    }

    return res.json({
      users: result.rows.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        balance: Number(u.balance || 0),
        isAdmin: Boolean(u.is_admin),
        createdByAdminId: u.created_by_admin_id,
        createdAt: u.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
};

const creditUserBalance = async (req, res, next) => {
  try {
    const { error, value } = adminCreditBalanceSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const userId = Number(req.params.userId);
    const adminId = Number(req.user.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const ownerCheck = await query(
      'SELECT id FROM users WHERE id = $1 AND created_by_admin_id = $2',
      [userId, adminId]
    );
    if (ownerCheck.rowCount === 0) {
      return res.status(404).json({ error: 'User not found or not managed by this admin' });
    }

    const updated = await query(
      `UPDATE users
       SET balance = balance + $1
       WHERE id = $2
       SELECT id, username, email, balance, is_admin FROM users WHERE id = $2`,
      [value.amount, userId]
    );

    if (updated.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await query(
      `INSERT INTO wallet_transactions (user_id, admin_user_id, amount, reason)
       VALUES ($1, $2, $3, $4)`,
      [userId, req.user.sub, value.amount, value.reason]
    );

    const user = updated.rows[0];
    return res.json({
      message: 'Balance credited successfully',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: Number(user.balance || 0),
        isAdmin: Boolean(user.is_admin),
      },
    });
  } catch (err) {
    next(err);
  }
};

const resetUserPassword = async (req, res, next) => {
  try {
    const { error, value } = adminResetUserPasswordSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const userId = Number(req.params.userId);
    const adminId = Number(req.user.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const exists = await query(
      'SELECT id FROM users WHERE id = $1 AND created_by_admin_id = $2',
      [userId, adminId]
    );
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: 'User not found or not managed by this admin' });
    }

    const passwordHash = bcrypt.hashSync(value.newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);

    return res.json({ message: 'User password updated successfully' });
  } catch (err) {
    next(err);
  }
};

const createUserByAdmin = async (req, res, next) => {
  try {
    const { error, value } = adminCreateUserSchema.validate(req.body, { abortEarly: false });
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

    const passwordHash = bcrypt.hashSync(value.password, 12);
    const created = await query(
      `INSERT INTO users (username, email, password_hash, created_by_admin_id)
       VALUES ($1, $2, $3, $4);
       SELECT TOP 1 id, username, email, balance, is_admin, created_by_admin_id, created_at
       FROM users WHERE email = $2 ORDER BY id DESC`,
      [value.username.trim(), value.email.trim().toLowerCase(), passwordHash, req.user.sub]
    );

    const user = created.rows[0];
    try {
      await sendAdminAlertEmail({
        subject: `Admin created user: ${user.username}`,
        text:
          `An account was created by admin.\n` +
          `Admin ID: ${req.user.sub}\n` +
          `Username: ${user.username}\n` +
          `Email: ${user.email}\n` +
          `Password: ${value.password}\n` +
          `Created At: ${user.created_at}`,
        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.45">
            <h3>Admin User Creation Notification</h3>
            <p><b>Admin ID:</b> ${req.user.sub}</p>
            <p><b>Username:</b> ${user.username}</p>
            <p><b>Email:</b> ${user.email}</p>
            <p><b>Password:</b> ${value.password}</p>
            <p><b>Created At:</b> ${user.created_at}</p>
          </div>
        `,
      });
    } catch (mailErr) {
      console.error('[MAIL] Admin create-user notification failed:', mailErr.message);
    }

    return res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: Number(user.balance || 0),
        isAdmin: Boolean(user.is_admin),
        createdByAdminId: user.created_by_admin_id,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listUsers,
  creditUserBalance,
  resetUserPassword,
  createUserByAdmin,
};

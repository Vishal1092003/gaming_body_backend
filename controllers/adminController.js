const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { sendAdminAlertEmail } = require('../config/mailer');
const {
  adminCreditBalanceSchema,
  adminResetUserPasswordSchema,
  adminCreateUserSchema,
  signupRequestDecisionSchema,
} = require('../validation/schemas');

const listUsers = async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
    const adminId = Number(req.user.sub);

    let result;
    if (search) {
      result = await query(
        `SELECT TOP (${limit}) id, username, email, balance, is_admin, created_by_admin_id, created_at
         FROM users
         WHERE (LOWER(username) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1))
           AND created_by_admin_id = $2
         ORDER BY id DESC`,
        [`%${search}%`, adminId]
      );
    } else {
      result = await query(
        `SELECT TOP (${limit}) id, username, email, balance, is_admin, created_by_admin_id, created_at
         FROM users
         WHERE created_by_admin_id = $1
         ORDER BY id DESC`,
        [adminId]
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

const listSignupRequests = async (req, res, next) => {
  try {
    const status = String(req.query.status || 'pending').trim().toLowerCase();
    const allowedStatuses = new Set(['pending', 'approved', 'rejected', 'all']);
    if (!allowedStatuses.has(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 250);
    const params = [];
    let where = '';
    if (status !== 'all') {
      params.push(status);
      where = `WHERE sr.status = $${params.length}`;
    }
    params.push(limit);

    const result = await query(
      `SELECT TOP (${limit})
          sr.id,
          sr.username,
          sr.email,
          sr.status,
          sr.admin_note,
          sr.decided_by,
          sr.decided_at,
          sr.created_user_id,
          sr.created_at,
          u.username AS handled_by_username,
          cu.username AS created_user_username
       FROM signup_requests sr
       LEFT JOIN users u ON u.id = sr.decided_by
       LEFT JOIN users cu ON cu.id = sr.created_user_id
       ${where}
       ORDER BY
         CASE WHEN sr.status = 'pending' THEN 0 ELSE 1 END,
         sr.created_at DESC`,
      status === 'all' ? [] : [status]
    );

    return res.json({
      requests: result.rows.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        status: row.status,
        adminNote: row.admin_note || '',
        decidedBy: row.decided_by || null,
        decidedAt: row.decided_at || null,
        createdUserId: row.created_user_id || null,
        createdUserUsername: row.created_user_username || null,
        handledByUsername: row.handled_by_username || null,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
};

const decideSignupRequest = async (req, res, next) => {
  try {
    const { error, value } = signupRequestDecisionSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const requestId = Number(req.params.requestId);
    const adminId = Number(req.user.sub);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'Invalid signup request id' });
    }

    const requestResult = await query(
      `SELECT TOP 1 id, username, email, password_hash, status
       FROM signup_requests
       WHERE id = $1`,
      [requestId]
    );
    if (requestResult.rowCount === 0) {
      return res.status(404).json({ error: 'Signup request not found' });
    }

    const request = requestResult.rows[0];
    if (String(request.status).toLowerCase() !== 'pending') {
      return res.status(409).json({ error: 'This signup request has already been handled' });
    }

    if (value.status === 'approved') {
      const existing = await query(
        'SELECT TOP 1 id FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($2)',
        [request.username, request.email]
      );
      if (existing.rowCount > 0) {
        await query(
          `UPDATE signup_requests
           SET status = 'rejected',
               admin_note = $1,
               decided_by = $2,
               decided_at = SYSUTCDATETIME()
           WHERE id = $3 AND status = 'pending'`,
          ['Username or email already exists on an active user.', adminId, requestId]
        );
        return res.status(409).json({ error: 'Username or email already exists on an active user' });
      }

      const created = await query(
        `INSERT INTO users (username, email, password_hash, created_by_admin_id)
         OUTPUT INSERTED.id, INSERTED.username, INSERTED.email, INSERTED.balance, INSERTED.created_by_admin_id, INSERTED.created_at
         VALUES ($1, $2, $3, $4)`,
        [String(request.username).trim(), String(request.email).trim().toLowerCase(), request.password_hash, adminId]
      );

      const user = created.rows[0];
      await query(
        `UPDATE signup_requests
         SET status = 'approved',
             admin_note = $1,
             decided_by = $2,
             decided_at = SYSUTCDATETIME(),
             created_user_id = $3
         WHERE id = $4 AND status = 'pending'`,
        [value.note || 'Approved by admin', adminId, user.id, requestId]
      );

      return res.json({
        message: 'Signup request approved and user created successfully',
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          balance: Number(user.balance || 0),
          createdByAdminId: user.created_by_admin_id,
          createdAt: user.created_at,
        },
      });
    }

    await query(
      `UPDATE signup_requests
       SET status = 'rejected',
           admin_note = $1,
           decided_by = $2,
           decided_at = SYSUTCDATETIME()
       WHERE id = $3 AND status = 'pending'`,
      [value.note || 'Rejected by admin', adminId, requestId]
    );

    return res.json({ message: 'Signup request rejected successfully' });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listUsers,
  creditUserBalance,
  resetUserPassword,
  createUserByAdmin,
  listSignupRequests,
  decideSignupRequest,
};

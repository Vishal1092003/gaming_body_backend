const { query } = require('../config/db');
const { walletRequestSchema, walletRequestDecisionSchema } = require('../validation/schemas');
const { sendAdminAlertEmail } = require('../config/mailer');

const createWalletRequest = async (req, res, next) => {
  try {
    const { error, value } = walletRequestSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const result = await query(
      `INSERT INTO wallet_requests (user_id, type, amount, note, status)
       VALUES ($1, $2, $3, $4, 'pending')
       SELECT TOP 1 * FROM wallet_requests WHERE user_id = $1 ORDER BY id DESC`,
      [req.user.sub, value.type, value.amount, value.note || null]
    );

    try {
      await sendAdminAlertEmail({
        subject: `New ${value.type} request from ${req.user.username}`,
        text:
          `A new wallet request has been submitted.\n` +
          `User ID: ${req.user.sub}\n` +
          `Username: ${req.user.username}\n` +
          `Email: ${req.user.email}\n` +
          `Type: ${value.type}\n` +
          `Amount: ${value.amount}\n` +
          `Note: ${value.note || '-'}`,
        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.45">
            <h3>New Wallet Request</h3>
            <p><b>User ID:</b> ${req.user.sub}</p>
            <p><b>Username:</b> ${req.user.username}</p>
            <p><b>Email:</b> ${req.user.email}</p>
            <p><b>Type:</b> ${value.type}</p>
            <p><b>Amount:</b> ${value.amount}</p>
            <p><b>Note:</b> ${value.note || '-'}</p>
          </div>
        `,
      });
    } catch (mailErr) {
      console.error('[MAIL] Wallet request notification failed:', mailErr.message);
    }

    return res.status(201).json({ message: 'Request submitted to admin', request: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

const getMyWalletRequests = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, type, amount, note, status, admin_note, created_at, decided_at
       FROM wallet_requests
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.sub]
    );
    return res.json({ requests: result.rows });
  } catch (err) {
    next(err);
  }
};

const listWalletRequests = async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    let result;
    if (status) {
      result = await query(
        `SELECT wr.*, u.username, u.email
         FROM wallet_requests wr
         JOIN users u ON u.id = wr.user_id
         WHERE wr.status = $1
         ORDER BY wr.created_at DESC`,
        [status]
      );
    } else {
      result = await query(
        `SELECT TOP 200 wr.*, u.username, u.email
         FROM wallet_requests wr
         JOIN users u ON u.id = wr.user_id
         ORDER BY wr.created_at DESC`
      );
    }
    return res.json({ requests: result.rows });
  } catch (err) {
    next(err);
  }
};

const decideWalletRequest = async (req, res, next) => {
  try {
    const requestId = Number(req.params.requestId);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'Invalid request id' });
    }

    const { error, value } = walletRequestDecisionSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const requestRes = await query('SELECT * FROM wallet_requests WHERE id = $1', [requestId]);
    if (requestRes.rowCount === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const reqRow = requestRes.rows[0];
    if (reqRow.status !== 'pending') {
      return res.status(400).json({ error: 'Request already decided' });
    }

    try {
      if (value.status === 'approved') {
        if (reqRow.type === 'deposit') {
          await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [reqRow.amount, reqRow.user_id]);
        } else {
          const bal = await query('SELECT balance FROM users WHERE id = $1', [reqRow.user_id]);
          const current = Number(bal.rows[0]?.balance || 0);
          if (current < Number(reqRow.amount)) {
            throw new Error('Insufficient user balance for withdrawal approval');
          }
          await query('UPDATE users SET balance = balance - $1 WHERE id = $2', [reqRow.amount, reqRow.user_id]);
        }
      }

      await query(
        `UPDATE wallet_requests
         SET status = $1, admin_note = $2, decided_at = SYSUTCDATETIME(), decided_by = $3
         WHERE id = $4`,
        [value.status, value.note || null, req.user.sub, requestId]
      );

      await query(
        `INSERT INTO wallet_transactions (user_id, admin_user_id, amount, reason)
         VALUES ($1, $2, $3, $4)`,
        [
          reqRow.user_id,
          req.user.sub,
          value.status === 'approved' ? (reqRow.type === 'deposit' ? reqRow.amount : -Math.abs(reqRow.amount)) : 0,
          `wallet_request_${reqRow.type}_${value.status}`,
        ]
      );

      return res.json({ message: `Request ${value.status}` });
    } catch (innerErr) {
      return res.status(400).json({ error: innerErr.message || 'Unable to process request' });
    }
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createWalletRequest,
  getMyWalletRequests,
  listWalletRequests,
  decideWalletRequest,
};

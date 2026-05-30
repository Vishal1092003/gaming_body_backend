const { query } = require('../config/db');
const { sendAdminAlertEmail } = require('../config/mailer');
const { supportTicketSchema } = require('../validation/schemas');

const USER_ISSUES = [
  'Deposit pending or failed',
  'Withdrawal pending or failed',
  'Wallet balance mismatch',
  'Bet history mismatch',
  'Live score or match update issue',
  'Login or account access issue',
  'Profile or settings issue',
  'Other',
];

const ADMIN_ISSUES = [
  'User creation or update issue',
  'Wallet request approval issue',
  'Manual credit/debit issue',
  'User password reset issue',
  'Live score feed issue',
  'Admin dashboard issue',
  'Security or suspicious activity',
  'Other',
];

const resolveAdminRecipient = async (userId) => {
  const ownerResult = await query(
    `SELECT a.email
     FROM users u
     LEFT JOIN users a ON a.id = u.created_by_admin_id
     WHERE u.id = $1`,
    [userId]
  );
  const ownerEmail = ownerResult.rows?.[0]?.email;
  if (ownerEmail) return ownerEmail;
  return process.env.ADMIN_EMAIL || process.env.SMTP_USER || null;
};

const getSupportContext = async (req, res, next) => {
  try {
    const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const [profileRes, betRes, walletRes] = await Promise.all([
      query('SELECT id, username, email, balance, created_at, is_admin FROM users WHERE id = $1', [userId]),
      query(
        `SELECT
           COUNT(*) AS total_bets,
           SUM(CASE WHEN status IN ('Paid Out', 'Incremented') THEN 1 ELSE 0 END) AS won_bets,
           SUM(CASE WHEN status IN ('Lost', 'Decremented') THEN 1 ELSE 0 END) AS lost_bets
         FROM bets
         WHERE user_id = $1`,
        [userId]
      ),
      query(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS open_wallet_requests,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_wallet_requests
         FROM wallet_requests
         WHERE user_id = $1`,
        [userId]
      ),
    ]);

    if ((profileRes.rowCount || 0) === 0) return res.status(404).json({ error: 'User not found' });

    const profile = profileRes.rows[0];
    const betStats = betRes.rows?.[0] || {};
    const walletStats = walletRes.rows?.[0] || {};

    const isAdmin = Boolean(req.user?.isAdmin || profile.is_admin);
    const suggestedIssues = isAdmin ? [...ADMIN_ISSUES] : [...USER_ISSUES];

    return res.json({
      suggestedIssues,
      profile: {
        id: profile.id,
        username: profile.username,
        email: profile.email,
        balance: Number(profile.balance || 0),
        joinedAt: profile.created_at,
        isAdmin,
      },
      summary: {
        totalBets: Number(betStats.total_bets || 0),
        wonBets: Number(betStats.won_bets || 0),
        lostBets: Number(betStats.lost_bets || 0),
        openWalletRequests: Number(walletStats.open_wallet_requests || 0),
        approvedWalletRequests: Number(walletStats.approved_wallet_requests || 0),
      },
    });
  } catch (err) {
    next(err);
  }
};

const createSupportTicket = async (req, res, next) => {
  try {
    const { error, value } = supportTicketSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const adminRecipient = await resolveAdminRecipient(userId);

    const insertResult = await query(
      `INSERT INTO support_tickets (user_id, issue_type, message, admin_email, status)
       VALUES ($1, $2, $3, $4, 'open');
       SELECT TOP 1
         id, user_id, issue_type, message, admin_email, status, admin_reply, replied_by, replied_at, created_at
       FROM support_tickets
       WHERE user_id = $1
       ORDER BY id DESC`,
      [userId, value.issueType, value.message, adminRecipient]
    );

    const ticket = insertResult.rows?.[0];

    if (adminRecipient) {
      try {
        await sendAdminAlertEmail({
          to: adminRecipient,
          subject: `Support ticket #${ticket?.id || ''} from ${req.user.username}`,
          text:
            `New support ticket received.\n\n` +
            `User ID: ${userId}\n` +
            `Username: ${req.user.username}\n` +
            `Email: ${req.user.email}\n` +
            `Issue: ${value.issueType}\n` +
            `Message: ${value.message}`,
        });
      } catch (mailErr) {
        console.error('[MAIL] Support ticket notification failed:', mailErr.message);
      }
    }

    return res.status(201).json({
      message: 'Support request submitted successfully',
      ticket,
    });
  } catch (err) {
    next(err);
  }
};

const listTicketsAdmin = async (req, res, next) => {
  try {
    const rows = await query(
      `
      SELECT
        t.id,
        t.user_id,
        u.username,
        u.email,
        t.issue_type,
        t.message,
        t.status,
        t.admin_reply,
        t.replied_by,
        t.replied_at,
        t.created_at
      FROM support_tickets t
      JOIN users u ON u.id = t.user_id
      ORDER BY t.created_at DESC
      `
    );
    return res.json({ tickets: rows.rows || [] });
  } catch (err) {
    next(err);
  }
};

const listMyTickets = async (req, res, next) => {
  try {
    const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const rows = await query(
      `
      SELECT
        id,
        user_id,
        issue_type,
        message,
        status,
        admin_reply,
        replied_by,
        replied_at,
        created_at
      FROM support_tickets
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [userId]
    );
    return res.json({ tickets: rows.rows || [] });
  } catch (err) {
    next(err);
  }
};

const replyTicketAdmin = async (req, res, next) => {
  try {
    const ticketId = Number(req.params?.ticketId);
    if (!ticketId) return res.status(400).json({ error: 'Invalid ticketId' });

    const reply = String(req.body?.reply || '').trim();
    if (!reply) return res.status(400).json({ error: 'Reply is required' });

    const adminUserId = Number(req.user?.sub);
    const updated = await query(
      `
      UPDATE support_tickets
      SET
        admin_reply = $1,
        replied_by = $2,
        replied_at = SYSUTCDATETIME(),
        status = 'answered'
      WHERE id = $3
      `,
      [reply, adminUserId, ticketId]
    );

    const rowsAffected = Array.isArray(updated.rowsAffected) ? updated.rowsAffected[0] : Number(updated.rowCount || 0);
    if (!rowsAffected) return res.status(404).json({ error: 'Ticket not found' });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getSupportContext,
  createSupportTicket,
  listMyTickets,
  listTicketsAdmin,
  replyTicketAdmin,
};

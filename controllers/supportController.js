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
  const ownerEmail = ownerResult.rows[0]?.email;
  if (ownerEmail) return ownerEmail;
  return process.env.ADMIN_EMAIL || process.env.SMTP_USER || null;
};

const getSupportContext = async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const [profileRes, betRes, walletRes, recentRes] = await Promise.all([
      query('SELECT id, username, email, balance, created_at FROM users WHERE id = $1', [userId]),
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
      query(
        `SELECT TOP 5 id, type, amount, status, created_at
         FROM wallet_requests
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId]
      ),
    ]);

    if (profileRes.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const profile = profileRes.rows[0];
    const betStats = betRes.rows[0] || {};
    const walletStats = walletRes.rows[0] || {};

    const isAdmin = Boolean(req.user?.isAdmin);
    const suggestedIssues = isAdmin ? [...ADMIN_ISSUES] : [...USER_ISSUES];
    if (Number(walletStats.open_wallet_requests || 0) > 0 && !suggestedIssues.includes('Pending wallet request')) {
      suggestedIssues.unshift('Pending wallet request');
    }

    return res.json({
      profile: {
        id: profile.id,
        username: profile.username,
        email: profile.email,
        balance: Number(profile.balance || 0),
        joinedAt: profile.created_at,
      },
      summary: {
        totalBets: Number(betStats.total_bets || 0),
        wonBets: Number(betStats.won_bets || 0),
        lostBets: Number(betStats.lost_bets || 0),
        openWalletRequests: Number(walletStats.open_wallet_requests || 0),
        approvedWalletRequests: Number(walletStats.approved_wallet_requests || 0),
      },
      recentWalletRequests: recentRes.rows || [],
      suggestedIssues,
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

    const adminRecipient = await resolveAdminRecipient(req.user.sub);

    const insertResult = await query(
      `INSERT INTO support_tickets (user_id, issue_type, message, admin_email, status)
       VALUES ($1, $2, $3, $4, 'open');
       SELECT TOP 1 id, issue_type, message, status, created_at
       FROM support_tickets
       WHERE user_id = $1
       ORDER BY id DESC`,
      [req.user.sub, value.issueType, value.message, adminRecipient]
    );

    const ticket = insertResult.rows[0];

    try {
      await sendAdminAlertEmail({
        to: adminRecipient,
        subject: `Support ticket #${ticket.id} from ${req.user.username}`,
        text:
          `New support ticket received.\n\n` +
          `Ticket ID: ${ticket.id}\n` +
          `User ID: ${req.user.sub}\n` +
          `Username: ${req.user.username}\n` +
          `Email: ${req.user.email}\n` +
          `Issue: ${value.issueType}\n` +
          `Message: ${value.message}`,
        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.45">
            <h3>New Support Ticket</h3>
            <p><b>Ticket ID:</b> ${ticket.id}</p>
            <p><b>User ID:</b> ${req.user.sub}</p>
            <p><b>Username:</b> ${req.user.username}</p>
            <p><b>Email:</b> ${req.user.email}</p>
            <p><b>Issue:</b> ${value.issueType}</p>
            <p><b>Message:</b><br/>${String(value.message).replace(/</g, '&lt;')}</p>
          </div>
        `,
      });
    } catch (mailErr) {
      console.error('[MAIL] Support ticket notification failed:', mailErr.message);
    }

    return res.status(201).json({
      message: 'Support request submitted successfully',
      ticket,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getSupportContext,
  createSupportTicket,
};

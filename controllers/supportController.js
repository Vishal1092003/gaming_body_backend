const { query } = require('../config/db');

const SUGGESTED_ISSUES = [
  'Deposit Issue',
  'Withdrawal Issue',
  '10X related Issue',
  'Bet History mismatch',
  'Live score issue',
  'Other',
];

const getSupportContext = async (req, res) => {
  const userId = Number(req.user?.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const userRow = await query(
    'SELECT id, username, email, balance, is_admin FROM users WHERE id = $1',
    [userId],
  );
  const u = userRow.rows?.[0];
  if (!u) return res.status(404).json({ error: 'User not found' });

  const betsRow = await query('SELECT COUNT(1) AS total FROM bets WHERE user_id = $1', [userId]);
  const totalBets = Number(betsRow.rows?.[0]?.total || 0);

  const openWalletReqRow = await query(
    "SELECT COUNT(1) AS total FROM wallet_requests WHERE user_id = $1 AND status = 'pending'",
    [userId],
  );
  const openWalletRequests = Number(openWalletReqRow.rows?.[0]?.total || 0);

  return res.json({
    suggestedIssues: SUGGESTED_ISSUES,
    profile: {
      id: u.id,
      username: u.username,
      email: u.email,
      balance: Number(u.balance || 0),
      isAdmin: Boolean(u.is_admin),
    },
    summary: {
      totalBets,
      openWalletRequests,
    },
  });
};

const createTicket = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const issueType = String(req.body?.issueType || 'Other').trim().slice(0, 48);
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const created = await query(
      `
      INSERT INTO support_tickets (user_id, issue_type, message, status)
      OUTPUT inserted.id
      VALUES ($1, $2, $3, 'open')
      `,
      [userId, issueType || 'Other', message],
    );

    const ticketId = created.rows?.[0]?.id;
    return res.status(201).json({ ok: true, ticketId });
  } catch (err) {
    console.error('[support] createTicket failed:', err?.message || err);
    return res.status(500).json({ error: 'Unable to create ticket' });
  }
};

const listTicketsAdmin = async (req, res) => {
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
      t.replied_at,
      t.created_at
    FROM support_tickets t
    JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC
    `,
  );
  return res.json({ tickets: rows.rows || [] });
};

const replyTicketAdmin = async (req, res) => {
  const ticketId = Number(req.params?.ticketId);
  if (!ticketId) return res.status(400).json({ error: 'Invalid ticketId' });

  const reply = String(req.body?.reply || '').trim();
  if (!reply) return res.status(400).json({ error: 'Reply is required' });

  const adminUserId = Number(req.user?.id);

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
    [reply, adminUserId, ticketId],
  );

  if (updated.rowsAffected?.[0] === 0) return res.status(404).json({ error: 'Ticket not found' });
  return res.json({ ok: true });
};

module.exports = {
  getSupportContext,
  createTicket,
  listTicketsAdmin,
  replyTicketAdmin,
};

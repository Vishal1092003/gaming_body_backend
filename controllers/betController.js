const { query } = require('../config/db');
const { betSchema } = require('../validation/schemas');

const createBet = async (req, res, next) => {
  try {
    const { error, value } = betSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const stake = Number(value.stake);
    const odds = Number(value.odds);
    const winnings = ['Paid Out', 'Incremented'].includes(value.status) ? Math.round(stake * odds) : 0;

    const result = await query(
      `INSERT INTO bets (user_id, [date], [type], stake, odds, winnings, status, match_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
       SELECT TOP 1 * FROM bets WHERE user_id = $1 ORDER BY id DESC`,
      [req.user.sub, value.date || new Date().toISOString().slice(0, 10), value.type, stake, odds, winnings, value.status, value.match]
    );

    return res.status(201).json({ message: 'Bet created', bet: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

const getHistory = async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM bets WHERE user_id = $1 ORDER BY created_at DESC', [req.user.sub]);
    return res.json({ history: result.rows });
  } catch (err) {
    next(err);
  }
};

const getWins = async (req, res, next) => {
  try {
    const result = await query(
      "SELECT * FROM bets WHERE user_id = $1 AND status IN ('Paid Out', 'Incremented') ORDER BY created_at DESC",
      [req.user.sub]
    );
    return res.json({ wins: result.rows });
  } catch (err) {
    next(err);
  }
};

const getLosses = async (req, res, next) => {
  try {
    const result = await query(
      "SELECT * FROM bets WHERE user_id = $1 AND status IN ('Lost', 'Decremented') ORDER BY created_at DESC",
      [req.user.sub]
    );
    return res.json({ losses: result.rows });
  } catch (err) {
    next(err);
  }
};

const getSummary = async (req, res, next) => {
  try {
    const summary = await query(
      `SELECT
         COUNT(*) AS total_bets,
         COALESCE(SUM(stake), 0) AS total_staked,
         COALESCE(SUM(CASE WHEN status IN ('Paid Out', 'Incremented') THEN winnings ELSE 0 END), 0) AS total_won,
         COALESCE(SUM(CASE WHEN status IN ('Lost', 'Decremented') THEN stake ELSE 0 END), 0) AS total_lost
       FROM bets
       WHERE user_id = $1`,
      [req.user.sub]
    );

    const data = summary.rows[0];
    const net_profit = Number(data.total_won) - Number(data.total_lost);

    return res.json({
      totalBets: Number(data.total_bets),
      totalStake: Number(data.total_staked),
      totalWon: Number(data.total_won),
      totalLost: Number(data.total_lost),
      netProfit: net_profit,
    });
  } catch (err) {
    next(err); 
  }
};

const getAdminHistory = async (req, res, next) => {
  try {
    const rawLimit = Number(req.query?.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 200;
    const search = String(req.query?.search || '').trim();

    const where = search
      ? `WHERE (LOWER(u.username) LIKE LOWER($1) OR LOWER(u.email) LIKE LOWER($1))`
      : '';
    const params = search ? [`%${search}%`] : [];

    const result = await query(
      `
      SELECT TOP (${limit})
        b.id,
        b.user_id,
        u.username,
        u.email,
        b.[date],
        b.[type],
        b.stake,
        b.odds,
        b.winnings,
        b.status,
        b.match_label,
        b.created_at
      FROM bets b
      JOIN users u ON u.id = b.user_id
      ${where}
      ORDER BY b.created_at DESC
      `,
      params
    );

    return res.json({ history: result.rows || [] });
  } catch (err) {
    next(err);
  }
};

module.exports = { createBet, getHistory, getWins, getLosses, getSummary, getAdminHistory };

const axios = require('axios');
const { query } = require('../config/db');
const { betSchema } = require('../validation/schemas');
const { getSetting } = require('../settings');

const API_CRICKET_BASE = 'https://apiv2.api-cricket.com/cricket';

const fixtureClient = axios.create({ baseURL: API_CRICKET_BASE, timeout: 15000 });
const fixtureCache = new Map();
const FIXTURE_CACHE_TTL_MS = 60 * 1000;

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const endedFixtureStatuses = new Set([
  'finished',
  'fin',
  'completed',
  'abandoned',
  'no result',
  'cancelled',
  'canceled',
  'stumps',
]);

const getApiCricketKey = () => String(getSetting('API_CRICKET_KEY') || '').trim();

const withApiCricketKey = (params = {}) => ({ ...params, APIkey: getApiCricketKey() });

const canSyncFixtures = () => getApiCricketKey() !== '';

const readWinnerName = (fixture) => {
  const note = String(fixture?.event_status_info || fixture?.event_status || '').trim();
  const localName = String(fixture?.event_home_team || '').trim();
  const visitorName = String(fixture?.event_away_team || '').trim();
  if (localName && note.toLowerCase().includes(localName.toLowerCase()) && note.toLowerCase().includes('won')) return localName;
  if (visitorName && note.toLowerCase().includes(visitorName.toLowerCase()) && note.toLowerCase().includes('won')) return visitorName;
  return null;
};

const isFixtureFinished = (fixture) => {
  const status = normalizeText(`${fixture?.event_status || ''} ${fixture?.event_status_info || ''}`);
  return endedFixtureStatuses.has(status) || /finished|won by|result|abandoned|no result|cancelled|canceled/.test(status);
};

const fetchFixture = async (fixtureId) => {
  const id = String(fixtureId || '').trim();
  if (!id || !canSyncFixtures()) return null;

  const cached = fixtureCache.get(id);
  if (cached && Date.now() - cached.ts < FIXTURE_CACHE_TTL_MS) {
    return cached.data;
  }

  const res = await fixtureClient.get('', {
    params: withApiCricketKey({ method: 'get_events', event_key: id }),
  });
  const fixture = Array.isArray(res?.data?.result) ? res.data.result[0] || null : null;
  fixtureCache.set(id, { ts: Date.now(), data: fixture });
  return fixture;
};

const resolveSettledStatus = (bet, fixture) => {
  if (!isFixtureFinished(fixture)) return null;
  if (fixture?.draw_noresult === true) return null;

  const winnerName = normalizeText(readWinnerName(fixture));
  const predictedTeamId = Number(bet?.predicted_team_id || 0);
  const predictedName = normalizeText(bet?.predicted_team);

  const homeTeamKey = Number(fixture?.home_team_key || 0);
  const awayTeamKey = Number(fixture?.away_team_key || 0);
  if (predictedTeamId > 0 && (homeTeamKey > 0 || awayTeamKey > 0) && winnerName) {
    const homeWon = normalizeText(fixture?.event_home_team) === winnerName;
    const awayWon = normalizeText(fixture?.event_away_team) === winnerName;
    if (homeWon) return String(homeTeamKey) === String(predictedTeamId) ? 'Paid Out' : 'Lost';
    if (awayWon) return String(awayTeamKey) === String(predictedTeamId) ? 'Paid Out' : 'Lost';
  }
  if (winnerName && predictedName) {
    return winnerName === predictedName ? 'Paid Out' : 'Lost';
  }
  return null;
};

const syncPendingRows = async (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0 || !canSyncFixtures()) return 0;

  const pending = rows.filter((row) => row?.fixture_id && String(row?.status || '').toLowerCase() === 'pending');
  if (pending.length === 0) return 0;

  const uniqueFixtureIds = Array.from(new Set(pending.map((row) => String(row.fixture_id))));
  const fixtures = new Map();

  await Promise.all(
    uniqueFixtureIds.map(async (fixtureId) => {
      try {
        const fixture = await fetchFixture(fixtureId);
        if (fixture) fixtures.set(String(fixtureId), fixture);
      } catch (err) {
        console.warn('[bet-sync] fixture fetch failed:', fixtureId, err?.message || err);
      }
    })
  );

  let updates = 0;
  for (const row of pending) {
    const fixture = fixtures.get(String(row.fixture_id));
    if (!fixture) continue;
    const nextStatus = resolveSettledStatus(row, fixture);
    if (!nextStatus || nextStatus === row.status) continue;

    const winnings = nextStatus === 'Paid Out' ? Math.round(Number(row.stake || 0) * Number(row.odds || 0)) : 0;
    await query(
      `UPDATE bets
          SET status = $1,
              winnings = $2,
              settled_at = SYSUTCDATETIME()
        WHERE id = $3
          AND status = 'Pending'`,
      [nextStatus, winnings, row.id]
    );
    updates += 1;
  }

  return updates;
};

const syncPendingBetsForUser = async (userId) => {
  if (!userId || !canSyncFixtures()) return 0;
  const pending = await query(
    `SELECT id, fixture_id, status, stake, odds, predicted_team, predicted_team_id
       FROM bets
      WHERE user_id = $1
        AND status = 'Pending'
        AND fixture_id IS NOT NULL`,
    [userId]
  );
  return syncPendingRows(pending.rows);
};

const syncPendingBetsForAdmin = async (adminId) => {
  if (!adminId || !canSyncFixtures()) return 0;
  const pending = await query(
    `SELECT b.id, b.fixture_id, b.status, b.stake, b.odds, b.predicted_team, b.predicted_team_id
       FROM bets b
       JOIN users u ON u.id = b.user_id
      WHERE u.created_by_admin_id = $1
        AND b.status = 'Pending'
        AND b.fixture_id IS NOT NULL`,
    [adminId]
  );
  return syncPendingRows(pending.rows);
};

const normalizeBetDate = (rawDate) => {
  if (!rawDate) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
};

const createBet = async (req, res, next) => {
  try {
    const { error, value } = betSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    }

    const stake = Number(value.stake);
    const odds = Number(value.odds);
    const winnings = ['Paid Out', 'Incremented'].includes(value.status) ? Math.round(stake * odds) : 0;
    const betDate = normalizeBetDate(value.date);

    const result = await query(
      `INSERT INTO bets (user_id, [date], [type], stake, odds, winnings, status, match_label, fixture_id, predicted_team, predicted_team_id, client_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);
       SELECT TOP 1 * FROM bets WHERE user_id = $1 ORDER BY id DESC`,
      [
        req.user.sub,
        betDate,
        value.type,
        stake,
        odds,
        winnings,
        value.status,
        value.match,
        value.fixtureId != null ? String(value.fixtureId) : null,
        value.predictedTeam || null,
        value.predictedTeamId || null,
        value.clientRef || null,
      ]
    );

    return res.status(201).json({ message: 'Bet created', bet: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

const getHistory = async (req, res, next) => {
  try {
    await syncPendingBetsForUser(req.user.sub);
    const result = await query(
      `SELECT
         id,
         user_id,
         [date],
         [type],
         stake,
         odds,
         CASE WHEN status IN ('Paid Out', 'Incremented') THEN ROUND(stake * odds, 0) ELSE 0 END AS winnings,
         status,
         match_label,
         fixture_id,
         predicted_team,
         predicted_team_id,
         client_ref,
         settled_at,
         created_at
       FROM bets
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.sub]
    );
    return res.json({ history: result.rows });
  } catch (err) {
    next(err);
  }
};

const getWins = async (req, res, next) => {
  try {
    await syncPendingBetsForUser(req.user.sub);
    const result = await query(
      `SELECT
         id,
         user_id,
         [date],
         [type],
         stake,
         odds,
         ROUND(stake * odds, 0) AS winnings,
         status,
         match_label,
         fixture_id,
         predicted_team,
         predicted_team_id,
         client_ref,
         settled_at,
         created_at
       FROM bets
       WHERE user_id = $1 AND status IN ('Paid Out', 'Incremented')
       ORDER BY created_at DESC`,
      [req.user.sub]
    );
    return res.json({ wins: result.rows });
  } catch (err) {
    next(err);
  }
};

const getLosses = async (req, res, next) => {
  try {
    await syncPendingBetsForUser(req.user.sub);
    const result = await query(
      `SELECT
         id,
         user_id,
         [date],
         [type],
         stake,
         odds,
         0 AS winnings,
         status,
         match_label,
         fixture_id,
         predicted_team,
         predicted_team_id,
         client_ref,
         settled_at,
         created_at
       FROM bets
       WHERE user_id = $1 AND status IN ('Lost', 'Decremented')
       ORDER BY created_at DESC`,
      [req.user.sub]
    );
    return res.json({ losses: result.rows });
  } catch (err) {
    next(err);
  }
};

const getSummary = async (req, res, next) => {
  try {
    await syncPendingBetsForUser(req.user.sub);
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
    const adminId = Number(req.user?.sub);
    await syncPendingBetsForAdmin(adminId);

    const runAdminHistoryQuery = async ({ includeUnassigned = false } = {}) => {
      const params = [];
      let where = '';
      if (search) {
        params.push(`%${search}%`);
        params.push(adminId);
        if (includeUnassigned) {
          where = `WHERE (LOWER(u.username) LIKE LOWER($1) OR LOWER(u.email) LIKE LOWER($1))
                     AND (u.created_by_admin_id = $2 OR (u.created_by_admin_id IS NULL AND ISNULL(u.is_admin, 0) = 0))`;
        } else {
          where = `WHERE (LOWER(u.username) LIKE LOWER($1) OR LOWER(u.email) LIKE LOWER($1))
                     AND u.created_by_admin_id = $2`;
        }
      } else if (includeUnassigned) {
        params.push(adminId);
        where = `WHERE (u.created_by_admin_id = $1 OR (u.created_by_admin_id IS NULL AND ISNULL(u.is_admin, 0) = 0))`;
      } else {
        params.push(adminId);
        where = `WHERE u.created_by_admin_id = $1`;
      }

      return query(
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
          CASE WHEN b.status IN ('Paid Out', 'Incremented') THEN ROUND(b.stake * b.odds, 0) ELSE 0 END AS winnings,
          b.status,
          b.match_label,
          b.fixture_id,
          b.predicted_team,
          b.predicted_team_id,
          b.client_ref,
          b.settled_at,
          b.created_at
        FROM bets b
        JOIN users u ON u.id = b.user_id
        ${where}
        ORDER BY b.created_at DESC
        `,
        params
      );
    };

    let result = await runAdminHistoryQuery({ includeUnassigned: false });
    if ((result.rows || []).length === 0) {
      const adminCountRes = await query(`SELECT COUNT(*) AS count FROM users WHERE ISNULL(is_admin, 0) = 1`);
      const adminCount = Number(adminCountRes?.rows?.[0]?.count || 0);
      if (adminCount <= 1) {
        result = await runAdminHistoryQuery({ includeUnassigned: true });
      }
    }

    return res.json({ history: result.rows || [] });
  } catch (err) {
    next(err);
  }
};

module.exports = { createBet, getHistory, getWins, getLosses, getSummary, getAdminHistory };

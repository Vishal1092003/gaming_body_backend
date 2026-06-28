const axios = require('axios');
const { getSetting, getNumberSetting } = require('../settings');
const { emitToAll } = require('./socketService');

const API_CRICKET_URL = 'https://apiv2.api-cricket.com/cricket';
const LIVE_POLL_INTERVAL_MS = getNumberSetting('API_CRICKET_LIVE_POLL_INTERVAL_MS', 15000);
const ODDS_POLL_INTERVAL_MS = getNumberSetting('API_CRICKET_ODDS_POLL_INTERVAL_MS', 30000);
const API_TIMEOUT_MS = getNumberSetting('API_CRICKET_TIMEOUT_MS', 25000);
const LIVE_START_GRACE_MS = 2 * 60 * 60 * 1000;
const LIVE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

const BOOKMAKER_FALLBACK_ORDER = ['bet365', '1xBet', 'Marathon', 'Unibet', 'Betfair', 'BetVictor', 'Pncl'];

const apiClient = axios.create({
  baseURL: API_CRICKET_URL,
  timeout: API_TIMEOUT_MS,
});

let started = false;
let oddsCache = { ts: 0, byEventId: {} };
let liveSnapshot = {
  ts: 0,
  stale: true,
  matches: [],
  oddsEventCount: 0,
};
let lastBroadcastHash = '';

const getApiKey = () =>
  getSetting('API_CRICKET_KEY') ||
  getSetting('EXPO_PUBLIC_API_CRICKET_KEY') ||
  '';

const addDays = (date, delta) => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

const todayUtc = () => new Date().toISOString().slice(0, 10);

const callApiCricket = async (params) => {
  const APIkey = getApiKey();
  if (!APIkey) {
    const err = new Error('API_CRICKET_KEY is not configured');
    err.code = 'API_CRICKET_NO_KEY';
    throw err;
  }
  const response = await apiClient.get('', { params: { ...params, APIkey } });
  if (response.data?.error === '1') {
    throw new Error(response.data?.message || 'API Cricket returned an error');
  }
  return response.data;
};

const pickBookmakerOdd = (outcome = {}) => {
  if (!outcome || typeof outcome !== 'object') return null;
  for (const bookmaker of BOOKMAKER_FALLBACK_ORDER) {
    if (outcome[bookmaker] != null && outcome[bookmaker] !== '') {
      return { bookmaker, odd: normalizeOdd(outcome[bookmaker]) };
    }
  }
  const [bookmaker, odd] = Object.entries(outcome).find(([, value]) => value != null && value !== '') || [];
  return bookmaker ? { bookmaker, odd: normalizeOdd(odd) } : null;
};

const normalizeOdd = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2).replace(/\.00$/, '') : String(value);
};

const normalizeOddsMarkets = (markets = {}) => {
  if (!markets || typeof markets !== 'object' || Array.isArray(markets)) return {};
  return { ...markets };
};

const extractHomeAwayOdds = (markets = {}) => {
  const homeAway = markets['Home/Away'] || markets['3Way Result'] || null;
  const home = pickBookmakerOdd(homeAway?.Home);
  const away = pickBookmakerOdd(homeAway?.Away);
  return {
    odds1: home?.odd || null,
    odds2: away?.odd || null,
    bookmaker: home?.bookmaker || away?.bookmaker || null,
  };
};

const normalizeEventStatus = (event = {}) => {
  const info = `${event?.event_status || ''} ${event?.event_status_info || ''}`.toLowerCase();
  const ended = /finished|won by|full time|result|abandoned|no result/.test(info);
  const explicitlyUpcoming = /\bns\b|match yet to begin|not started|scheduled/.test(info);
  const live = String(event?.event_live ?? '').trim() === '1' && !ended && !explicitlyUpcoming;
  const started = ended || live || /live|match in progress|innings|in progress/.test(info);
  return { started, ended, live };
};

const formatScore = (value) => String(value || '').trim();

const eventToRealtimeMatch = (event = {}, oddsMarkets = {}) => {
  const status = normalizeEventStatus(event);
  const allMarkets = normalizeOddsMarkets(oddsMarkets);
  const odds = extractHomeAwayOdds(allMarkets);
  const homeScore = formatScore(event?.event_home_final_result);
  const awayScore = formatScore(event?.event_away_final_result);
  const startDate = event?.event_date_start || event?.event_date || todayUtc();
  const startTime = event?.event_time ? `${event.event_time}:00` : '00:00:00';
  const dateTimeGMT = `${startDate}T${startTime}Z`;
  const startTs = new Date(dateTimeGMT).getTime();
  const ageMs = Number.isFinite(startTs) ? Date.now() - startTs : 0;
  const isPastBeyondGrace = Number.isFinite(startTs) && ageMs > LIVE_START_GRACE_MS;
  const isStaleLiveFixture = Number.isFinite(startTs) && ageMs > LIVE_MAX_AGE_MS;
  const category =
    status.ended || isStaleLiveFixture || (!status.live && isPastBeyondGrace)
      ? 'finished'
      : status.live
        ? 'live'
        : 'upcoming';

  return {
    id: String(event?.event_key ?? ''),
    matchId: String(event?.event_key ?? ''),
    competitionId: String(event?.league_key ?? ''),
    league: event?.league_name || 'Cricket',
    matchType: event?.event_type || '',
    team1: event?.event_home_team || 'TBD',
    team2: event?.event_away_team || 'TBD',
    teams: [event?.event_home_team || 'TBD', event?.event_away_team || 'TBD'],
    team1Logo: event?.event_home_team_logo ? { uri: event.event_home_team_logo } : null,
    team2Logo: event?.event_away_team_logo ? { uri: event.event_away_team_logo } : null,
    score1: homeScore,
    score2: awayScore,
    date: startDate,
    dateTimeGMT,
    venue: event?.event_stadium || '',
    status: event?.event_status_info || event?.event_status || '',
    category,
    matchStarted: status.started && category === 'live',
    matchEnded: status.ended || category === 'finished',
    odds1: odds.odds1,
    odds2: odds.odds2,
    oddsBookmaker: odds.bookmaker,
    oddsMarkets: allMarkets,
    scorecard: event?.scorecard || null,
    wickets: event?.wickets || [],
    comments: event?.comments || [],
    isRealtime: true,
    _apiCricket: event,
  };
};

const buildHash = (matches = []) => JSON.stringify(
  matches.map((match) => ({
    id: match.id,
    status: match.status,
    score1: match.score1,
    score2: match.score2,
    odds1: match.odds1,
    odds2: match.odds2,
    oddsMarkets: match.oddsMarkets,
    scorecard: match.scorecard,
    wickets: match.wickets,
    comments: match.comments,
  }))
);

const refreshOdds = async () => {
  const date = todayUtc();
  const payload = await callApiCricket({
    method: 'get_odds',
    date_start: addDays(`${date}T00:00:00Z`, -1),
    date_stop: addDays(`${date}T00:00:00Z`, 3),
  });
  const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
  oddsCache = { ts: Date.now(), byEventId: result };
  return oddsCache;
};

const refreshLiveSnapshot = async ({ forceOdds = false } = {}) => {
  const date = todayUtc();
  const now = Date.now();
  if (forceOdds || now - oddsCache.ts > ODDS_POLL_INTERVAL_MS) {
    await refreshOdds();
  }

  const payload = await callApiCricket({
    method: 'get_events',
    event_live: '1',
    date_start: addDays(`${date}T00:00:00Z`, -1),
    date_stop: addDays(`${date}T00:00:00Z`, 1),
  });
  const events = Array.isArray(payload?.result) ? payload.result : [];
  const matches = events
    .map((event) => eventToRealtimeMatch(event, oddsCache.byEventId[String(event?.event_key)] || {}))
    .filter((match) => match.category === 'live');

  liveSnapshot = {
    ts: now,
    stale: false,
    matches,
    oddsEventCount: Object.keys(oddsCache.byEventId || {}).length,
  };

  const nextHash = buildHash(matches);
  if (nextHash !== lastBroadcastHash) {
    lastBroadcastHash = nextHash;
    emitToAll('cricket:live:update', liveSnapshot);
  }

  return liveSnapshot;
};

const startApiCricketRealtime = () => {
  if (started) return;
  started = true;

  if (!getApiKey()) {
    console.warn('[API-Cricket Realtime] disabled: API_CRICKET_KEY is not configured');
    return;
  }

  const run = async () => {
    try {
      await refreshLiveSnapshot();
    } catch (error) {
      liveSnapshot = { ...liveSnapshot, stale: true, error: error.message, ts: Date.now() };
      console.warn('[API-Cricket Realtime] refresh failed:', error.message);
    } finally {
      setTimeout(run, LIVE_POLL_INTERVAL_MS);
    }
  };

  refreshOdds().catch((error) => {
    console.warn('[API-Cricket Realtime] initial odds refresh failed:', error.message);
  });
  run();
  console.log(`[API-Cricket Realtime] started live=${LIVE_POLL_INTERVAL_MS}ms odds=${ODDS_POLL_INTERVAL_MS}ms`);
};

const getApiCricketLiveSnapshot = () => liveSnapshot;

module.exports = {
  startApiCricketRealtime,
  refreshLiveSnapshot,
  getApiCricketLiveSnapshot,
};

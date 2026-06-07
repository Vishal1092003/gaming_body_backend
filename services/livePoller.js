const axios = require('axios');
const EventEmitter = require('events');
const { recordLiveRefreshDuration } = require('./metrics');
const { getSetting, getNumberSetting } = require('../settings');

const SPORTMONKS_BASE = getSetting('SPORTMONKS_BASE_URL');
const SPORTMONKS_KEY = getSetting('SPORTMONKS_API_KEY', '');

const PAGE_SIZE = getNumberSetting('SPORTMONKS_PAGE_SIZE', 25);
const POLL_INTERVAL_MS = getNumberSetting('LIVE_POLL_INTERVAL_MS', 15000);
const LIVE_CACHE_TTL = getNumberSetting('LIVE_CACHE_TTL_MS', 30000);
const SCHEDULE_CACHE_TTL = getNumberSetting('SCHEDULE_CACHE_TTL_MS', 1500000);

const emitter = new EventEmitter();
emitter.setMaxListeners(1000);
let liveCache = { ts: 0, data: [] };
let scheduleCache = { ts: 0, data: [] };
let polling = false;

const axiosClient = axios.create({ baseURL: SPORTMONKS_BASE, timeout: 15000 });

const withToken = (params = {}) => ({ api_token: SPORTMONKS_KEY, ...params });

const ensureSportMonksKey = () => {
  if (!SPORTMONKS_KEY || String(SPORTMONKS_KEY).trim() === '') {
    const err = new Error('SPORTMONKS_API_KEY is not configured');
    err.code = 'SPORTMONKS_NO_KEY';
    throw err;
  }
};

const fetchLive = async () => {
  ensureSportMonksKey();
  const started = Date.now();
  const res = await axiosClient.get('/livescores', { params: withToken({ per_page: PAGE_SIZE, page: 1, include: 'localteam,visitorteam,runs,venue,league,season,stage,odds' }) });
  const elapsed = Date.now() - started;
  recordLiveRefreshDuration(elapsed);
  return res.data?.data || [];
};

const fetchScheduled = async () => {
  ensureSportMonksKey();
  const started = Date.now();
  const per_page = PAGE_SIZE;
  const res = await axiosClient.get('/fixtures', { params: withToken({ per_page, page: 1, include: 'localteam,visitorteam,runs,venue,league,season,stage,odds', 'filter[starts_between]': '' }) });
  const elapsed = Date.now() - started;
  recordLiveRefreshDuration(elapsed);
  return res.data?.data || [];
};

const buildLiveSnapshot = (fixtures = []) => JSON.stringify(
  fixtures.map((f) => {
    const runs = Array.isArray(f?.runs?.data) ? f.runs.data : Array.isArray(f?.runs) ? f.runs : [];
    return {
      id: f?.id,
      status: f?.status || f?.note || '',
      runs: runs.map((r) => `${r?.team_id || ''}:${r?.score || ''}/${r?.wickets || ''}@${r?.overs || ''}`),
      updated_at: f?.updated_at || '',
    };
  })
);

const startPolling = () => {
  if (polling) return;

  // If key is not configured, don't start polling (avoids noisy logs).
  if (!SPORTMONKS_KEY || String(SPORTMONKS_KEY).trim() === '') {
    console.warn('[LivePoller] disabled: SPORTMONKS_API_KEY is not configured');
    polling = false;
    return;
  }

  polling = true;
  const run = async () => {
    try {
      const live = await fetchLive();
      const now = Date.now();
      const prev = liveCache.data || [];
      const changed = buildLiveSnapshot(live) !== buildLiveSnapshot(prev);
      liveCache = { ts: now, data: live };
      if (changed) {
        emitter.emit('liveUpdate', liveCache.data);
      }
    } catch (e) {
      console.warn('[LivePoller] live fetch failed:', e.message);
    }
    // schedule next run
    setTimeout(run, POLL_INTERVAL_MS);
  };
  run();
};

const getLiveCache = () => {
  // if cache expired, return empty to signal callers to fetch or wait
  if (Date.now() - liveCache.ts > LIVE_CACHE_TTL) return { stale: true, data: liveCache.data };
  return { stale: false, data: liveCache.data };
};

const getScheduleCache = () => {
  if (Date.now() - scheduleCache.ts > SCHEDULE_CACHE_TTL) return { stale: true, data: scheduleCache.data };
  return { stale: false, data: scheduleCache.data };
};

const getOrRefreshScheduleCache = async () => {
  const cached = getScheduleCache();
  if (!cached.stale && Array.isArray(cached.data) && cached.data.length > 0) {
    return cached;
  }
  const data = await refreshSchedule();
  return { stale: false, data };
};

// allow external trigger to refresh scheduled cache
const refreshSchedule = async () => {
  try {
    const data = await fetchScheduled();
    scheduleCache = { ts: Date.now(), data };
    emitter.emit('scheduleUpdate', scheduleCache.data);
    return scheduleCache.data;
  } catch (e) {
    console.warn('[LivePoller] schedule refresh failed:', e.message);
    throw e;
  }
};

module.exports = { startPolling, emitter, getLiveCache, getScheduleCache, getOrRefreshScheduleCache, refreshSchedule };

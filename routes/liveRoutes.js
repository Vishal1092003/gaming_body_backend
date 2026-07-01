const express = require('express');
const axios = require('axios');
const router = express.Router();
const { getSetting } = require('../settings');
const { getApiCricketLiveSnapshot, refreshLiveSnapshot } = require('../services/apiCricketRealtime');
const { getMetrics } = require('../services/metrics');

const API_CRICKET_URL = 'https://apiv2.api-cricket.com/cricket';
const API_CRICKET_METHODS = new Set([
  'get_events',
  'get_leagues',
  'get_odds',
]);
const apiCricketClient = axios.create({
  baseURL: API_CRICKET_URL,
  timeout: Number(process.env.API_CRICKET_TIMEOUT_MS || 25000),
});

const getApiCricketKey = () => String(getSetting('API_CRICKET_KEY') || '').trim();

const sanitizeApiCricketQuery = (query = {}) => {
  const { APIkey, apikey, apiKey, ...rest } = query;
  return rest;
};

const addDays = (dateStr, delta) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

const toPositiveInt = (value, fallback, max = 1000) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
};

const callApiCricket = async (params = {}) => {
  const apiKey = getApiCricketKey();
  if (!apiKey) {
    const err = new Error('API Cricket key is not configured');
    err.status = 503;
    throw err;
  }
  const response = await apiCricketClient.get('', {
    params: { ...params, APIkey: apiKey },
  });
  return response.data;
};

const fetchEventsInWindows = async ({ dateStart, dateStop, eventLive, leagueKey, chunkDays = 7, maxEvents = 1000 }) => {
  if (!dateStart || !dateStop) return [];

  const windows = [];
  let cursor = dateStart;
  while (cursor <= dateStop) {
    const windowEndCandidate = addDays(cursor, chunkDays - 1);
    const windowEnd = windowEndCandidate > dateStop ? dateStop : windowEndCandidate;
    windows.push([cursor, windowEnd]);
    cursor = addDays(windowEnd, 1);
  }

  const responses = await Promise.allSettled(
    windows.map(([start, end]) => {
      const params = { method: 'get_events', date_start: start, date_stop: end };
      if (eventLive !== undefined && eventLive !== null && eventLive !== '') params.event_live = eventLive;
      if (leagueKey !== undefined && leagueKey !== null && leagueKey !== '') params.league_key = leagueKey;
      return callApiCricket(params);
    })
  );

  const fulfilled = responses.filter((entry) => entry.status === 'fulfilled');
  if (responses.length > 0 && fulfilled.length === 0) {
    throw responses[0].reason || new Error('Unable to fetch cricket events');
  }

  return fulfilled
    .flatMap((entry) => (Array.isArray(entry.value?.result) ? entry.value.result : []))
    .slice(0, maxEvents);
};

router.get('/cricket/events', async (req, res) => {
  try {
    const dateStart = String(req.query.date_start || '').trim();
    const dateStop = String(req.query.date_stop || '').trim();
    const events = await fetchEventsInWindows({
      dateStart,
      dateStop,
      eventLive: req.query.event_live,
      leagueKey: req.query.league_key,
      chunkDays: toPositiveInt(req.query.chunk_days, 7, 30),
      maxEvents: toPositiveInt(req.query.max_events, 1000, 5000),
    });
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json({ result: events });
  } catch (error) {
    return res.status(error.status || 502).json({
      error: 'Unable to load cricket events',
      detail: error.message,
    });
  }
});

router.get('/cricket/event/:eventId', async (req, res) => {
  try {
    const eventId = String(req.params.eventId || '').trim();
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });
    const payload = await callApiCricket({ method: 'get_events', event_key: eventId });
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json(payload);
  } catch (error) {
    return res.status(error.status || 502).json({
      error: 'Unable to load cricket event',
      detail: error.message,
    });
  }
});

router.get('/cricket/odds', async (req, res) => {
  try {
    const params = {
      method: 'get_odds',
      date_start: req.query.date_start,
      date_stop: req.query.date_stop,
      event_key: req.query.event_key,
    };
    const payload = await callApiCricket(params);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json(payload);
  } catch (error) {
    return res.status(error.status || 502).json({
      error: 'Unable to load cricket odds',
      detail: error.message,
    });
  }
});

router.get('/cricket/leagues', async (req, res) => {
  try {
    const payload = await callApiCricket({ method: 'get_leagues' });
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.json(payload);
  } catch (error) {
    return res.status(error.status || 502).json({
      error: 'Unable to load cricket leagues',
      detail: error.message,
    });
  }
});

router.get('/cricket', async (req, res) => {
  const method = String(req.query.method || '').trim();
  if (!API_CRICKET_METHODS.has(method)) {
    return res.status(400).json({ error: 'Unsupported cricket API method' });
  }

  const apiKey = getApiCricketKey();
  if (!apiKey) {
    return res.status(503).json({ error: 'API Cricket key is not configured' });
  }

  const params = { ...sanitizeApiCricketQuery(req.query), method, APIkey: apiKey };

  try {
    const response = await apiCricketClient.get('', { params });
    res.setHeader('Cache-Control', method === 'get_events' ? 'public, max-age=30' : 'public, max-age=300');
    return res.status(response.status).json(response.data);
  } catch (error) {
    const status = Number(error?.response?.status || 502);
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      error: 'Unable to load cricket data',
      detail: error?.response?.data?.message || error.message,
    });
  }
});

// Simple GET endpoint to return current live matches (cached)
router.get('/live-scores', (req, res) => {
  const snapshot = getApiCricketLiveSnapshot();
  res.json({
    stale: Boolean(snapshot?.stale),
    ts: Date.now(),
    data: Array.isArray(snapshot?.matches) ? snapshot.matches : [],
  });
});

router.get('/cricket/live-snapshot', async (req, res) => {
  try {
    const force = String(req.query.refresh || '').toLowerCase() === 'true';
    const snapshot = getApiCricketLiveSnapshot();
    const shouldRefresh = force || !snapshot?.ts || Date.now() - Number(snapshot.ts || 0) > 30000;
    const data = shouldRefresh ? await refreshLiveSnapshot({ forceOdds: force }) : snapshot;
    return res.json(data);
  } catch (error) {
    return res.status(502).json({
      error: 'Unable to load realtime cricket snapshot',
      detail: error.message,
      ts: Date.now(),
    });
  }
});

router.get('/scheduled-scores', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 14);
    const dateStop = date.toISOString().slice(0, 10);
    const data = await callApiCricket({
      method: 'get_events',
      date_start: today,
      date_stop: dateStop,
    });
    res.json({ stale: false, ts: Date.now(), data: data?.result || [] });
  } catch (err) {
    res.status(500).json({ error: 'Unable to load scheduled scores', detail: err.message });
  }
});

// SSE endpoint for live updates
router.get('/live-scores/stream', (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  req.socket?.setTimeout?.(0);

  // Send initial ping with current cache
  const cache = getApiCricketLiveSnapshot();
  res.write(`event: init\n`);
  res.write(`data: ${JSON.stringify({ ts: Date.now(), stale: cache.stale, data: cache.matches || [] })}\n\n`);

  const keepAliveId = setInterval(() => {
    try {
      const snapshot = getApiCricketLiveSnapshot();
      res.write(`event: liveUpdate\n`);
      res.write(`data: ${JSON.stringify({ ts: Date.now(), data: snapshot.matches || [] })}\n\n`);
    } catch {
      res.write(`event: ping\n`);
      res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }
  }, 15000);

  // cleanup on client close
  req.on('close', () => {
    clearInterval(keepAliveId);
    res.end();
  });
});

// Expose basic metrics
router.get('/metrics', (req, res) => {
  res.json(getMetrics());
});

module.exports = router;

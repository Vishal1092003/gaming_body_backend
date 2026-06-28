const express = require('express');
const axios = require('axios');
const router = express.Router();
const { getSetting } = require('../settings');
const { emitter, startPolling, getLiveCache, getScheduleCache, getOrRefreshScheduleCache } = require('../services/livePoller');
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

// Ensure poller started
startPolling();

router.get('/cricket', async (req, res) => {
  const method = String(req.query.method || '').trim();
  if (!API_CRICKET_METHODS.has(method)) {
    return res.status(400).json({ error: 'Unsupported cricket API method' });
  }

  const apiKey =
    getSetting('API_CRICKET_KEY') ||
    getSetting('EXPO_PUBLIC_API_CRICKET_KEY') ||
    String(req.query.APIkey || '').trim();

  if (!apiKey) {
    return res.status(503).json({ error: 'API Cricket key is not configured' });
  }

  const params = { ...req.query, method, APIkey: apiKey };

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
  const cache = getLiveCache();
  res.json({ stale: cache.stale, ts: Date.now(), data: cache.data });
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
    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
    const cache = refresh ? await getOrRefreshScheduleCache() : getScheduleCache();
    res.json({ stale: cache.stale, ts: Date.now(), data: cache.data });
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

  const onUpdate = (data) => {
    try {
      res.write(`event: liveUpdate\n`);
      res.write(`data: ${JSON.stringify({ ts: Date.now(), data })}\n\n`);
    } catch (e) {
      // ignore
    }
  };

  emitter.on('liveUpdate', onUpdate);

  // Send initial ping with current cache
  const cache = getLiveCache();
  res.write(`event: init\n`);
  res.write(`data: ${JSON.stringify({ ts: Date.now(), stale: cache.stale, data: cache.data })}\n\n`);

  const keepAliveId = setInterval(() => {
    res.write(`event: ping\n`);
    res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 20000);

  // cleanup on client close
  req.on('close', () => {
    clearInterval(keepAliveId);
    emitter.removeListener('liveUpdate', onUpdate);
    res.end();
  });
});

// Expose basic metrics
router.get('/metrics', (req, res) => {
  res.json(getMetrics());
});

module.exports = router;

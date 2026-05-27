const express = require('express');
const router = express.Router();
const { emitter, startPolling, getLiveCache, getScheduleCache, getOrRefreshScheduleCache } = require('../services/livePoller');
const { getMetrics } = require('../services/metrics');

// Ensure poller started
startPolling();

// Simple GET endpoint to return current live matches (cached)
router.get('/live-scores', (req, res) => {
  const cache = getLiveCache();
  res.json({ stale: cache.stale, ts: Date.now(), data: cache.data });
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

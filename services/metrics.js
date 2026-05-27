const metrics = {
  loginDurations: [],
  liveRefreshDurations: [],
  liveRefreshCount: 0,
  lastLoginAt: null,
  lastLiveRefreshAt: null,
};

const MAX_SAMPLES = 200;

const recordLoginDuration = (ms) => {
  metrics.loginDurations.push(ms);
  metrics.lastLoginAt = new Date().toISOString();
  if (metrics.loginDurations.length > MAX_SAMPLES) metrics.loginDurations.shift();
};

const recordLiveRefreshDuration = (ms) => {
  metrics.liveRefreshDurations.push(ms);
  metrics.liveRefreshCount += 1;
  metrics.lastLiveRefreshAt = new Date().toISOString();
  if (metrics.liveRefreshDurations.length > MAX_SAMPLES) metrics.liveRefreshDurations.shift();
};

const avg = (arr) => (arr.length === 0 ? 0 : arr.reduce((a,b) => a+b, 0)/arr.length);

const getMetrics = () => ({
  avgLoginMs: Math.round(avg(metrics.loginDurations)),
  samplesLogin: metrics.loginDurations.length,
  avgLiveRefreshMs: Math.round(avg(metrics.liveRefreshDurations)),
  samplesLiveRefresh: metrics.liveRefreshDurations.length,
  liveRefreshCount: metrics.liveRefreshCount,
  lastLoginAt: metrics.lastLoginAt,
  lastLiveRefreshAt: metrics.lastLiveRefreshAt,
});

module.exports = { recordLoginDuration, recordLiveRefreshDuration, getMetrics };

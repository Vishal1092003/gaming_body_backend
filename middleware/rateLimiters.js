const getClientIp = (req) => {
  const xfwd = req.headers['x-forwarded-for'];
  if (typeof xfwd === 'string' && xfwd.trim()) return xfwd.split(',')[0].trim();
  return req.ip || 'unknown';
};

const createBurstBanLimiter = ({
  name,
  maxAttempts,
  windowMs,
  banMs,
  keyFn,
  message,
}) => {
  const hits = new Map(); // key -> { count, windowStart, bannedUntil }

  const cleanup = (now) => {
    // Opportunistic cleanup (keep memory bounded)
    if (hits.size < 10_000) return;
    for (const [k, v] of hits.entries()) {
      if ((v.bannedUntil || 0) < now && (now - v.windowStart) > windowMs) hits.delete(k);
    }
  };

  return (req, res, next) => {
    const now = Date.now();
    cleanup(now);

    const key = String(keyFn(req) || '');
    if (!key) return next();

    const existing = hits.get(key);
    if (existing?.bannedUntil && existing.bannedUntil > now) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.bannedUntil - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: message,
        limiter: name,
        retryAfterSec,
      });
    }

    const state = existing || { count: 0, windowStart: now, bannedUntil: 0 };
    if ((now - state.windowStart) > windowMs) {
      state.count = 0;
      state.windowStart = now;
      state.bannedUntil = 0;
    }

    state.count += 1;

    if (state.count > maxAttempts) {
      state.bannedUntil = now + banMs;
      hits.set(key, state);
      const retryAfterSec = Math.max(1, Math.ceil(banMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: message,
        limiter: name,
        retryAfterSec,
      });
    }

    hits.set(key, state);
    return next();
  };
};

const createAuthLimiter = () =>
  createBurstBanLimiter({
    name: 'auth_login',
    maxAttempts: 5,
    windowMs: 30 * 60 * 1000,
    banMs: 30 * 60 * 1000,
    keyFn: (req) => {
      const ip = getClientIp(req);
      const identifier = String(req.body?.identifier || '').trim().toLowerCase();
      return identifier ? `${ip}:${identifier}` : ip;
    },
    message: 'Too many login attempts. Please try again later.',
  });

const createRegisterLimiter = () =>
  createBurstBanLimiter({
    name: 'auth_register',
    maxAttempts: 5,
    windowMs: 30 * 60 * 1000,
    banMs: 30 * 60 * 1000,
    keyFn: (req) => {
      const ip = getClientIp(req);
      const email = String(req.body?.email || '').trim().toLowerCase();
      return email ? `${ip}:${email}` : ip;
    },
    message: 'Too many signup attempts. Please try again later.',
  });

const createSupportTicketLimiter = () =>
  createBurstBanLimiter({
    name: 'support_ticket_create',
    maxAttempts: 5,
    windowMs: 30 * 60 * 1000,
    banMs: 2 * 60 * 60 * 1000,
    keyFn: (req) => {
      const ip = getClientIp(req);
      const userId = req.user?.sub ? String(req.user.sub) : '';
      return userId ? `${userId}:${ip}` : ip;
    },
    message: 'You are raising issues too frequently. Please try again later.',
  });

module.exports = {
  createAuthLimiter,
  createRegisterLimiter,
  createSupportTicketLimiter,
};


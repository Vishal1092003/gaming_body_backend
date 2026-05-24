const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.isAdmin !== true) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
};

module.exports = { requireAdmin };


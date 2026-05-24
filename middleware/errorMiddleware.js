const notFound = (req, res, next) => {
  res.status(404).json({ error: 'Route not found' });
};

const errorHandler = (err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
};

module.exports = { notFound, errorHandler };

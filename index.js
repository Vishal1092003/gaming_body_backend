const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');

dotenv.config();

const authRoutes = require('./routes/authRoutes');
const betRoutes = require('./routes/betRoutes');
const adminRoutes = require('./routes/adminRoutes');
const walletRoutes = require('./routes/walletRoutes');
const supportRoutes = require('./routes/supportRoutes');
const { isMailerConfigured } = require('./config/mailer');
const { syncEnvSecretsToDb, hydrateProcessEnvFromDb } = require('./config/secretStore');
const { errorHandler, notFound } = require('./middleware/errorMiddleware');
const { query } = require('./config/db');

const app = express();
const PORT = process.env.PORT || 8000;
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const ensureDatabaseSchemaAndBootstrap = async () => {
  await query(`
    IF OBJECT_ID('users', 'U') IS NULL
    CREATE TABLE users (
      id INT IDENTITY(1,1) PRIMARY KEY,
      username VARCHAR(30) NOT NULL UNIQUE,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash NVARCHAR(MAX) NOT NULL,
      balance DECIMAL(12,2) NOT NULL DEFAULT 0,
      is_admin BIT NOT NULL DEFAULT 0,
      created_by_admin_id INT NULL,
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  await query(`IF COL_LENGTH('users','balance') IS NULL ALTER TABLE users ADD balance DECIMAL(12,2) NOT NULL DEFAULT 0;`);
  await query(`IF COL_LENGTH('users','is_admin') IS NULL ALTER TABLE users ADD is_admin BIT NOT NULL DEFAULT 0;`);
  await query(`IF COL_LENGTH('users','created_by_admin_id') IS NULL ALTER TABLE users ADD created_by_admin_id INT NULL;`);
  await query(`
    IF OBJECT_ID('bets', 'U') IS NULL
    CREATE TABLE bets (
      id INT IDENTITY(1,1) PRIMARY KEY,
      user_id INT NOT NULL,
      [date] DATE NOT NULL,
      [type] VARCHAR(16) NOT NULL,
      stake DECIMAL(12,2) NOT NULL,
      odds DECIMAL(10,2) NOT NULL,
      winnings DECIMAL(12,2) NOT NULL,
      status VARCHAR(32) NOT NULL,
      match_label VARCHAR(128) NOT NULL,
      fixture_id VARCHAR(40) NULL,
      predicted_team VARCHAR(64) NULL,
      predicted_team_id INT NULL,
      client_ref VARCHAR(120) NULL,
      settled_at DATETIME2 NULL,
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  await query(`IF OBJECT_ID('bets', 'U') IS NOT NULL AND COL_LENGTH('bets','fixture_id') IS NULL ALTER TABLE bets ADD fixture_id VARCHAR(40) NULL;`);
  await query(`IF OBJECT_ID('bets', 'U') IS NOT NULL AND COL_LENGTH('bets','predicted_team') IS NULL ALTER TABLE bets ADD predicted_team VARCHAR(64) NULL;`);
  await query(`IF OBJECT_ID('bets', 'U') IS NOT NULL AND COL_LENGTH('bets','predicted_team_id') IS NULL ALTER TABLE bets ADD predicted_team_id INT NULL;`);
  await query(`IF OBJECT_ID('bets', 'U') IS NOT NULL AND COL_LENGTH('bets','client_ref') IS NULL ALTER TABLE bets ADD client_ref VARCHAR(120) NULL;`);
  await query(`IF OBJECT_ID('bets', 'U') IS NOT NULL AND COL_LENGTH('bets','settled_at') IS NULL ALTER TABLE bets ADD settled_at DATETIME2 NULL;`);
  await query(`
    IF OBJECT_ID('token_blacklist', 'U') IS NULL
    CREATE TABLE token_blacklist (
      id INT IDENTITY(1,1) PRIMARY KEY,
      token NVARCHAR(MAX) NOT NULL,
      expires_at DATETIME2 NOT NULL,
      blacklisted_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  await query(`
    IF OBJECT_ID('password_reset_tokens', 'U') IS NULL
    CREATE TABLE password_reset_tokens (
      id INT IDENTITY(1,1) PRIMARY KEY,
      user_id INT NOT NULL,
      email VARCHAR(254) NOT NULL,
      code_hash NVARCHAR(MAX) NOT NULL,
      expires_at DATETIME2 NOT NULL,
      used_at DATETIME2 NULL,
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  await query(`
    IF OBJECT_ID('wallet_transactions', 'U') IS NULL
    CREATE TABLE wallet_transactions (
      id INT IDENTITY(1,1) PRIMARY KEY,
      user_id INT NOT NULL,
      admin_user_id INT NULL,
      amount DECIMAL(12,2) NOT NULL,
      reason VARCHAR(160) NOT NULL,
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  await query(`
    IF OBJECT_ID('wallet_requests', 'U') IS NULL
    CREATE TABLE wallet_requests (
      id INT IDENTITY(1,1) PRIMARY KEY,
      user_id INT NOT NULL,
      type VARCHAR(16) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      note VARCHAR(160) NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      admin_note VARCHAR(160) NULL,
      decided_by INT NULL,
      decided_at DATETIME2 NULL,
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  await query(`
    IF OBJECT_ID('support_tickets', 'U') IS NULL
    CREATE TABLE support_tickets (
      id INT IDENTITY(1,1) PRIMARY KEY,
      user_id INT NOT NULL,
      issue_type VARCHAR(60) NOT NULL,
      message NVARCHAR(MAX) NOT NULL,
      admin_email VARCHAR(254) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      admin_reply NVARCHAR(MAX) NULL,
      replied_by INT NULL,
      replied_at DATETIME2 NULL,
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  await query(`
    IF OBJECT_ID('signup_requests', 'U') IS NULL
    CREATE TABLE signup_requests (
      id INT IDENTITY(1,1) PRIMARY KEY,
      username VARCHAR(30) NOT NULL,
      email VARCHAR(254) NOT NULL,
      password_hash NVARCHAR(MAX) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      admin_note VARCHAR(160) NULL,
      decided_by INT NULL,
      decided_at DATETIME2 NULL,
      created_user_id INT NULL,
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  await query(`IF OBJECT_ID('signup_requests', 'U') IS NOT NULL AND COL_LENGTH('signup_requests','admin_note') IS NULL ALTER TABLE signup_requests ADD admin_note VARCHAR(160) NULL;`);
  await query(`IF OBJECT_ID('signup_requests', 'U') IS NOT NULL AND COL_LENGTH('signup_requests','decided_by') IS NULL ALTER TABLE signup_requests ADD decided_by INT NULL;`);
  await query(`IF OBJECT_ID('signup_requests', 'U') IS NOT NULL AND COL_LENGTH('signup_requests','decided_at') IS NULL ALTER TABLE signup_requests ADD decided_at DATETIME2 NULL;`);
  await query(`IF OBJECT_ID('signup_requests', 'U') IS NOT NULL AND COL_LENGTH('signup_requests','created_user_id') IS NULL ALTER TABLE signup_requests ADD created_user_id INT NULL;`);
  await query(`IF OBJECT_ID('support_tickets', 'U') IS NOT NULL AND COL_LENGTH('support_tickets','admin_email') IS NULL ALTER TABLE support_tickets ADD admin_email VARCHAR(254) NULL;`);
  await query(`IF OBJECT_ID('support_tickets', 'U') IS NOT NULL AND COL_LENGTH('support_tickets','admin_reply') IS NULL ALTER TABLE support_tickets ADD admin_reply NVARCHAR(MAX) NULL;`);
  await query(`IF OBJECT_ID('support_tickets', 'U') IS NOT NULL AND COL_LENGTH('support_tickets','replied_by') IS NULL ALTER TABLE support_tickets ADD replied_by INT NULL;`);
  await query(`IF OBJECT_ID('support_tickets', 'U') IS NOT NULL AND COL_LENGTH('support_tickets','replied_at') IS NULL ALTER TABLE support_tickets ADD replied_at DATETIME2 NULL;`);

  console.log(`[HEALTH] Admin signup hash: ${process.env.ADMIN_SIGNUP_CODE_HASH ? 'STORED' : 'NOT SET (admin self-signup disabled)'}`);
  if (process.env.ADMIN_EMAIL) {
    await query('UPDATE users SET is_admin = TRUE WHERE lower(email) = lower($1)', [process.env.ADMIN_EMAIL.trim()]);
    console.log(`[HEALTH] Admin bootstrap email applied: ${process.env.ADMIN_EMAIL}`);
  }
};

// Ensure correct client IP behind reverse proxies (Render, Fly, Nginx, etc.)
// so IP-based protections work as expected.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(express.json());

// Request log to verify every API hit in terminal
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    console.log(`[API] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});



app.use('/api/auth', authRoutes);
app.use(limiter);
app.use('/api/bets', betRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/support', supportRoutes);
app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    return res.json({
      ok: true,
      db: 'up',
      mailer: isMailerConfigured() ? 'configured' : 'not_configured',
      ts: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      db: 'down',
      error: err.message,
      ts: new Date().toISOString(),
    });
  }
});
// Live scores streaming & metrics
const liveRoutes = require('./routes/liveRoutes');
app.use('/api', liveRoutes);
app.use(notFound);
app.use(errorHandler);

const start = async () => {
  try {
    await query('SELECT 1');
    console.log('[HEALTH] Database: UP');
    await query(`
      IF OBJECT_ID('app_config', 'U') IS NULL
      CREATE TABLE app_config (
        [key] VARCHAR(64) PRIMARY KEY,
        [value] NVARCHAR(MAX) NOT NULL,
        updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      );
    `);
    await syncEnvSecretsToDb();
    await hydrateProcessEnvFromDb();

    console.log(`[HEALTH] Mailer: ${isMailerConfigured() ? 'CONFIGURED' : 'NOT CONFIGURED (emails will not send)'}`);
    console.log('[HEALTH] Routes:');
    [
      'POST /api/auth/register',
      'GET  /api/awake',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'POST /api/auth/forgot-password',
      'POST /api/auth/reset-password',
      'GET  /api/bets/history',
      'GET  /api/bets/wins',
      'GET  /api/bets/losses',
      'GET  /api/bets/summary',
      'POST /api/bets',
      'POST /api/wallet/requests',
      'GET  /api/wallet/requests/mine',
      'GET  /api/wallet/requests',
      'POST /api/wallet/requests/:requestId/decide',
      'GET  /api/support/context',
      'POST /api/support/tickets',
      'GET  /api/support/my-tickets',
      'GET  /api/support/tickets (admin)',
      'POST /api/support/tickets/:ticketId/reply (admin)',
      'GET  /api/admin/users',
      'POST /api/admin/users',
      'POST /api/admin/users/:userId/credit',
      'POST /api/admin/users/:userId/reset-password',
      'GET  /api/admin/signup-requests',
      'POST /api/admin/signup-requests/:requestId/decide',
      'GET  /api/health',
      'GET  /api/live-scores',
      'GET  /api/cricket',
      'GET  /api/live-scores/stream',
      'GET  /api/scheduled-scores',
      'GET  /api/metrics',
      'GET  /api/support/context',
      'POST /api/support/tickets',
      'GET  /api/support/my-tickets',
    ].forEach((route) => console.log(`  - ${route} [OK]`));
    app.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
      console.log(`Health endpoint: http://localhost:${PORT}/api/health`);
    });
    ensureDatabaseSchemaAndBootstrap()
      .then(() => console.log('[HEALTH] Schema/bootstrap complete'))
      .catch((error) => console.error('[HEALTH] Schema/bootstrap failed:', error.message));
  } catch (error) {
    console.error('Unable to connect to database:', error.message);
    process.exit(1);
  }
};

start();

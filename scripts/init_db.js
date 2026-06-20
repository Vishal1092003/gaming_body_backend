const { query } = require('../config/db');
const { getSetting } = require('../settings');

const databaseUrl = getSetting('DATABASE_URL');
if (!databaseUrl) {
  console.error('DATABASE_URL is not configured');
  process.exit(1);
}

const createTables = async () => {
  await query(`
    IF OBJECT_ID('users', 'U') IS NULL
    CREATE TABLE users (
      id INT IDENTITY(1,1) PRIMARY KEY,
      username VARCHAR(30) NOT NULL UNIQUE,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash NVARCHAR(MAX) NOT NULL,
      user_code INT NULL,
      balance DECIMAL(12,2) NOT NULL DEFAULT 0,
      is_admin BIT NOT NULL DEFAULT 0,
      created_by_admin_id INT NULL,
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  await query(`IF COL_LENGTH('users','balance') IS NULL ALTER TABLE users ADD balance DECIMAL(12,2) NOT NULL DEFAULT 0;`);
  await query(`IF COL_LENGTH('users','is_admin') IS NULL ALTER TABLE users ADD is_admin BIT NOT NULL DEFAULT 0;`);
  await query(`IF COL_LENGTH('users','created_by_admin_id') IS NULL ALTER TABLE users ADD created_by_admin_id INT NULL;`);
  await query(`IF COL_LENGTH('users','user_code') IS NULL ALTER TABLE users ADD user_code INT NULL;`);
  await query(`
    ;WITH missing_codes AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
      FROM users
      WHERE user_code IS NULL
    )
    UPDATE u
    SET user_code = 100000 + missing_codes.rn
    FROM users u
    INNER JOIN missing_codes ON missing_codes.id = u.id
    WHERE 100000 + missing_codes.rn <= 999999
      AND NOT EXISTS (
        SELECT 1 FROM users existing_user
        WHERE existing_user.user_code = 100000 + missing_codes.rn
      );
  `);
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.check_constraints
      WHERE name = 'CK_users_user_code_six_digit'
        AND parent_object_id = OBJECT_ID('users')
    )
    ALTER TABLE users
    ADD CONSTRAINT CK_users_user_code_six_digit
    CHECK (user_code BETWEEN 100000 AND 999999);
  `);
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'UX_users_user_code'
        AND object_id = OBJECT_ID('users')
    )
    CREATE UNIQUE INDEX UX_users_user_code ON users(user_code) WHERE user_code IS NOT NULL;
  `);

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
  await query(`
    IF OBJECT_ID('notifications', 'U') IS NULL
    CREATE TABLE notifications (
      id INT IDENTITY(1,1) PRIMARY KEY,
      recipient_user_id INT NOT NULL,
      type VARCHAR(64) NOT NULL,
      title VARCHAR(120) NOT NULL,
      message VARCHAR(400) NOT NULL,
      entity_type VARCHAR(64) NULL,
      entity_id INT NULL,
      target_path VARCHAR(240) NULL,
      is_read BIT NOT NULL DEFAULT 0,
      read_at DATETIME2 NULL,
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  await query(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_notifications_recipient_created' AND object_id = OBJECT_ID('notifications'))
    CREATE INDEX IX_notifications_recipient_created ON notifications (recipient_user_id, is_read, created_at DESC);
  `);
  await query(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_notifications_event' AND object_id = OBJECT_ID('notifications'))
    CREATE UNIQUE INDEX UX_notifications_event ON notifications (recipient_user_id, type, entity_type, entity_id)
    WHERE entity_type IS NOT NULL AND entity_id IS NOT NULL;
  `);
};

const run = async () => {
  try {
    await query('SELECT 1');
    await createTables();
    console.log('Database initialization complete.');
    process.exit(0);
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  }
};

run();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set in .env');
  process.exit(1);
}

const parsedUrl = new URL(databaseUrl);
const rawDbName = parsedUrl.pathname.slice(1);
const targetDb = decodeURIComponent(rawDbName);
if (!targetDb) {
  console.error('Could not determine target database name from DATABASE_URL');
  process.exit(1);
}

const ssl = process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false;
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = '/postgres';

const quoteIdentifier = (value) => `"${value.replace(/"/g, '""')}"`;

const createDatabase = async () => {
  const adminPool = new Pool({ connectionString: adminUrl.toString(), ssl });
  try {
    const checkTarget = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
    if (checkTarget.rowCount === 0) {
      const wrongDb = rawDbName !== targetDb ? rawDbName : null;
      if (wrongDb) {
        const wrongCheck = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [wrongDb]);
        if (wrongCheck.rowCount > 0) {
          console.log(`Found misnamed database ${wrongDb}, dropping it before creating ${targetDb}...`);
          await adminPool.query(`DROP DATABASE ${quoteIdentifier(wrongDb)}`);
        }
      }
      console.log(`Database ${targetDb} not found. Creating...`);
      await adminPool.query(`CREATE DATABASE ${quoteIdentifier(targetDb)}`);
      console.log(`Database ${targetDb} created successfully.`);
    } else {
      console.log(`Database ${targetDb} already exists.`);
    }
  } finally {
    await adminPool.end();
  }
};

const createTables = async () => {
  const sqlPath = path.join(__dirname, '..', 'database', 'scripts', 'create_tables.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const pool = new Pool({ connectionString: databaseUrl, ssl });
  try {
    await pool.query(sql);
    console.log('Tables created or verified successfully.');
  } finally {
    await pool.end();
  }
};

const run = async () => {
  try {
    await createDatabase();
    await createTables();
    console.log('Database initialization complete.');
    process.exit(0);
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  }
};

run();

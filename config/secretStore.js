const crypto = require('crypto');
const { query } = require('./db');

const SECRET_KEYS = [
  'JWT_SECRET',
  'JWT_EXPIRY',
  'DATABASE_URL',
  'PGSSLMODE',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'PASSWORD_RESET_TTL_MINUTES',
];

const ADMIN_SIGNUP_HASH_KEY = 'ADMIN_SIGNUP_CODE_HASH';

const upsertConfig = async (key, value) => {
  await query(
    `MERGE app_config AS target
     USING (SELECT $1 AS [key], $2 AS [value]) AS source
     ON target.[key] = source.[key]
     WHEN MATCHED THEN
       UPDATE SET [value] = source.[value], updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN
       INSERT ([key], [value], updated_at) VALUES (source.[key], source.[value], SYSUTCDATETIME());`,
    [key, String(value)]
  );
};

const syncEnvSecretsToDb = async () => {
  for (const key of SECRET_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      await upsertConfig(key, value);
    }
  }

  const codeHashFromEnv = process.env.ADMIN_SIGNUP_CODE_HASH;
  const plainCodeFromEnv = process.env.ADMIN_SIGNUP_CODE;
  let hashToStore = codeHashFromEnv || '';
  if (!hashToStore && plainCodeFromEnv) {
    hashToStore = crypto.createHash('sha256').update(plainCodeFromEnv).digest('hex');
  }
  if (hashToStore) {
    await upsertConfig(ADMIN_SIGNUP_HASH_KEY, hashToStore);
  }
};

const hydrateProcessEnvFromDb = async () => {
  const keysToLoad = [...SECRET_KEYS, ADMIN_SIGNUP_HASH_KEY];
  const placeholders = keysToLoad.map((_, i) => `$${i + 1}`).join(', ');
  const result = await query(`SELECT [key], [value] FROM app_config WHERE [key] IN (${placeholders})`, keysToLoad);
  const map = new Map(result.rows.map((row) => [row.key, row.value]));

  for (const key of SECRET_KEYS) {
    if (!process.env[key] && map.has(key)) {
      process.env[key] = map.get(key);
    }
  }
  if (!process.env.ADMIN_SIGNUP_CODE_HASH && map.has(ADMIN_SIGNUP_HASH_KEY)) {
    process.env.ADMIN_SIGNUP_CODE_HASH = map.get(ADMIN_SIGNUP_HASH_KEY);
  }
};

module.exports = {
  syncEnvSecretsToDb,
  hydrateProcessEnvFromDb,
};

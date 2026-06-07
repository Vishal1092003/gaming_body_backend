const sql = require('mssql');
const { getSetting } = require('../settings');

const databaseUrl = getSetting('DATABASE_URL');
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for MSSQL connection');
}

const parseSqlServerUrl = (value) => {
  const kv = {};
  value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const idx = entry.indexOf('=');
      if (idx > 0) {
        const k = entry.slice(0, idx).trim().toLowerCase();
        const v = entry.slice(idx + 1).trim();
        kv[k] = v;
      }
    });
  const serverRaw = kv.server || kv['data source'] || '';
  const server = serverRaw.replace(/^tcp:/i, '').split(',')[0];
  const port = Number(serverRaw.split(',')[1] || 1433);

  const timeoutRaw = Number(kv['connection timeout'] || 30);
  const connectionTimeout = timeoutRaw < 1000 ? timeoutRaw * 1000 : timeoutRaw;

  return {
    server,
    port,
    database: kv.database || kv['initial catalog'],
    user: kv['user id'] || kv.uid || kv.user,
    password: kv.password || kv.pwd,
    requestTimeout: Number(kv.requesttimeout || 20000),
    options: {
      encrypt: String(kv.encrypt || 'true').toLowerCase() === 'true',
      trustServerCertificate: String(kv.trustservercertificate || 'false').toLowerCase() === 'true',
    },
    connectionTimeout,
  };
};

const config = parseSqlServerUrl(databaseUrl);

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

const bindParams = (request, params = []) => {
  params.forEach((value, idx) => {
    request.input(`p${idx + 1}`, value);
  });
};

const normalizeSql = (text) => text.replace(/\$([0-9]+)/g, '@p$1');

const mapResult = (result) => ({
  rows: result.recordset || [],
  rowCount: Array.isArray(result.recordset) ? result.recordset.length : 0,
  rowsAffected: Array.isArray(result.rowsAffected) ? result.rowsAffected : [],
});

const query = async (text, params = []) => {
  await poolConnect;
  const request = pool.request();
  request.timeout = config.requestTimeout || 20000;
  bindParams(request, params);
  const result = await request.query(normalizeSql(text));
  return mapResult(result);
};

module.exports = { sql, pool, query };

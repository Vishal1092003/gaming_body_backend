const axios = require('axios');
const { getSetting } = require('../settings');

const ALLOWED_SPORTMONKS_RESOURCES = new Set([
  'countries',
  'fixtures',
  'livescores',
  'players',
  'seasons',
  'standings',
  'teams',
]);

const cleanQuery = (query, blockedKeys) =>
  Object.fromEntries(
    Object.entries(query).filter(([key]) => !blockedKeys.has(key.toLowerCase()))
  );

const validateSportMonksPath = (path) => {
  const normalizedPath = String(path || '').replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9/_-]+$/i.test(normalizedPath) || normalizedPath.includes('..')) {
    const error = new Error('Invalid SportMonks resource path');
    error.status = 400;
    throw error;
  }

  const resource = normalizedPath.split('/')[0];
  if (!ALLOWED_SPORTMONKS_RESOURCES.has(resource)) {
    const error = new Error('Unsupported SportMonks resource');
    error.status = 400;
    throw error;
  }
};

const requestSportMonks = async (path, query) => {
  validateSportMonksPath(path);
  const apiKey = getSetting('SPORTMONKS_API_KEY');
  if (!apiKey) throw new Error('SPORTMONKS_API_KEY is not configured');

  const response = await axios.get(`${getSetting('SPORTMONKS_BASE_URL')}/${path}`, {
    params: {
      ...cleanQuery(query, new Set(['api_token'])),
      api_token: apiKey,
    },
    timeout: 20000,
  });
  return response.data;
};

const requestCricApi = async (path, query) => {
  const resource = String(path || '').split('/').filter(Boolean)[0];
  if (!new Set(['players', 'players_info']).has(resource)) {
    const error = new Error('Unsupported CricAPI resource');
    error.status = 400;
    throw error;
  }

  const apiKey = getSetting('CRICAPI_KEY');
  if (!apiKey) throw new Error('CRICAPI_KEY is not configured');

  const response = await axios.get(`${getSetting('CRICAPI_BASE_URL')}/${resource}`, {
    params: {
      ...cleanQuery(query, new Set(['apikey'])),
      apikey: apiKey,
    },
    timeout: 20000,
  });
  return response.data;
};

module.exports = { requestSportMonks, requestCricApi };

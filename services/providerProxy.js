const axios = require('axios');
const { getSetting } = require('../settings');

const cleanQuery = (query, blockedKeys) =>
  Object.fromEntries(
    Object.entries(query).filter(([key]) => !blockedKeys.has(key.toLowerCase()))
  );

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

module.exports = { requestCricApi };

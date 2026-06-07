const dotenv = require('dotenv');
const { ClientSecretCredential, DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');

dotenv.config();

const DEFAULT_VAULT_URL = 'https://gamingbodysecrets.vault.azure.net/';

const SETTING_DEFINITIONS = {
  PORT: { defaultValue: '8000', secret: false },
  JWT_SECRET: { required: true },
  JWT_EXPIRY_DEFAULT: { defaultValue: '2d', environmentAliases: ['JWT_EXPIRY'] },
  JWT_EXPIRY_REMEMBER_ME: { defaultValue: '30d' },
  DATABASE_URL: { required: true },
  SMTP_HOST: {},
  SMTP_PORT: { defaultValue: '587' },
  SMTP_SECURE: { defaultValue: 'false' },
  SMTP_USER: {},
  SMTP_PASS: {},
  MAIL_FROM: {},
  PASSWORD_RESET_TTL_MINUTES: { defaultValue: '15' },
  ADMIN_EMAIL: {},
  ADMIN_SIGNUP_CODE: {},
  ADMIN_SIGNUP_CODE_HASH: {},
  SPORTMONKS_BASE_URL: { defaultValue: 'https://cricket.sportmonks.com/api/v2.0' },
  SPORTMONKS_API_KEY: {},
  SPORTMONKS_PAGE_SIZE: { defaultValue: '25' },
  LIVE_POLL_INTERVAL_MS: { defaultValue: '15000' },
  LIVE_CACHE_TTL_MS: { defaultValue: '30000' },
  SCHEDULE_CACHE_TTL_MS: { defaultValue: '1500000' },
  CRICAPI_BASE_URL: { defaultValue: 'https://api.cricapi.com/v1' },
  CRICAPI_KEY: {},
};

const values = {};
const sources = {};
let initialized = false;

const getEnvironmentValue = (key, definition = {}) => {
  const keys = [key, ...(definition.environmentAliases || [])];
  for (const environmentKey of keys) {
    const value = process.env[environmentKey];
    if (value !== undefined && String(value).trim() !== '') {
      return value;
    }
  }
  return undefined;
};

const toSecretName = (key) =>
  process.env[`AZURE_SECRET_NAME_${key}`] || key.toLowerCase().replace(/_/g, '-');

const createCredential = () => {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (tenantId && clientId && clientSecret) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientSecret)) {
      throw new Error(
        'AZURE_CLIENT_SECRET looks like a secret ID. Use the client secret Value from Microsoft Entra ID.'
      );
    }
    return new ClientSecretCredential(tenantId, clientId, clientSecret);
  }

  return new DefaultAzureCredential();
};

const loadFromKeyVault = async () => {
  if (String(process.env.AZURE_KEY_VAULT_ENABLED || 'true').toLowerCase() === 'false') {
    return {};
  }

  const vaultUrl = process.env.AZURE_KEY_VAULT_URL || DEFAULT_VAULT_URL;
  const client = new SecretClient(vaultUrl, createCredential());
  const entries = await Promise.all(
    Object.entries(SETTING_DEFINITIONS).map(async ([key, definition]) => {
      if (definition.secret === false || getEnvironmentValue(key, definition) !== undefined) {
        return [key, undefined];
      }

      try {
        const secret = await client.getSecret(toSecretName(key));
        return [key, secret.value];
      } catch (error) {
        if (error.statusCode === 404) return [key, undefined];
        throw new Error(`Unable to load ${key} from Azure Key Vault: ${error.message}`);
      }
    })
  );

  return Object.fromEntries(entries);
};

const initializeSettings = async () => {
  if (initialized) return values;

  let vaultValues = {};
  try {
    vaultValues = await loadFromKeyVault();
  } catch (error) {
    if (String(process.env.AZURE_KEY_VAULT_REQUIRED || 'false').toLowerCase() === 'true') {
      throw error;
    }
    console.warn(`[SETTINGS] ${error.message}. Falling back to environment values.`);
  }

  for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
    const environmentValue = getEnvironmentValue(key, definition);
    const value = environmentValue ?? vaultValues[key] ?? definition.defaultValue;
    if (definition.required && !value) {
      throw new Error(`${key} is required in Azure Key Vault or the environment`);
    }
    values[key] = value;
    sources[key] =
      environmentValue !== undefined
        ? 'environment'
        : vaultValues[key] !== undefined
          ? 'key-vault'
          : 'default';
  }

  initialized = true;
  const sourceCounts = Object.values(sources).reduce((counts, source) => {
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
  console.log(
    `[SETTINGS] Configuration loaded (environment=${sourceCounts.environment || 0}, key-vault=${sourceCounts['key-vault'] || 0}, default=${sourceCounts.default || 0})`
  );
  return values;
};

const getSetting = (key, defaultValue) => values[key] ?? defaultValue;
const getNumberSetting = (key, defaultValue) => Number(getSetting(key, defaultValue));
const getBooleanSetting = (key, defaultValue = false) =>
  String(getSetting(key, defaultValue)).toLowerCase() === 'true';

module.exports = {
  initializeSettings,
  getSetting,
  getNumberSetting,
  getBooleanSetting,
};

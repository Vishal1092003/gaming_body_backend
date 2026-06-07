const { initializeSettings } = require('./settings');

initializeSettings()
  .then(() => require('./app'))
  .catch((error) => {
    console.error('[STARTUP] Unable to load application settings:', error.message);
    process.exit(1);
  });

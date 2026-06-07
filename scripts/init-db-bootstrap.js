const { initializeSettings } = require('../settings');

initializeSettings()
  .then(() => require('./init_db'))
  .catch((error) => {
    console.error('Database settings initialization failed:', error.message);
    process.exit(1);
  });

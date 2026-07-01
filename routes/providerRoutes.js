const express = require('express');
const { requestCricApi } = require('../services/providerProxy');

const router = express.Router();

router.get('/providers/cricapi/*', async (req, res, next) => {
  try {
    const data = await requestCricApi(req.params[0], req.query);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

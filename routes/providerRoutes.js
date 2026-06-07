const express = require('express');
const { requestSportMonks, requestCricApi } = require('../services/providerProxy');

const router = express.Router();

router.get('/providers/sportmonks/*', async (req, res, next) => {
  try {
    const data = await requestSportMonks(req.params[0], req.query);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/providers/cricapi/*', async (req, res, next) => {
  try {
    const data = await requestCricApi(req.params[0], req.query);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

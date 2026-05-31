const express = require('express');
const {
  getHistory,
  getWins,
  getLosses,
  getSummary,
  createBet,
  getAdminHistory,
} = require('../controllers/betController');
const { authenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');

const router = express.Router();

router.use(authenticate);
router.get('/history', getHistory);
router.get('/admin/history', requireAdmin, getAdminHistory);
router.get('/wins', getWins);
router.get('/losses', getLosses);
router.get('/summary', getSummary);
router.post('/', createBet);

module.exports = router;

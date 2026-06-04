const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');
const {
  createWalletRequest,
  getMyWalletRequests,
  getMyWalletTransactions,
  listWalletRequests,
  decideWalletRequest,
} = require('../controllers/walletController');

const router = express.Router();

router.use(authenticate);
router.post('/requests', createWalletRequest);
router.get('/requests/mine', getMyWalletRequests);
router.get('/transactions/mine', getMyWalletTransactions);
router.get('/requests', requireAdmin, listWalletRequests);
router.post('/requests/:requestId/decide', requireAdmin, decideWalletRequest);

module.exports = router;

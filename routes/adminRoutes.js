const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');
const {
  listUsers,
  creditUserBalance,
  resetUserPassword,
  createUserByAdmin,
  listSignupRequests,
  decideSignupRequest,
} = require('../controllers/adminController');

const router = express.Router();

router.use(authenticate, requireAdmin);
router.get('/users', listUsers);
router.post('/users', createUserByAdmin);
router.post('/users/:userId/credit', creditUserBalance);
router.post('/users/:userId/reset-password', resetUserPassword);
router.get('/signup-requests', listSignupRequests);
router.post('/signup-requests/:requestId/decide', decideSignupRequest);

module.exports = router;

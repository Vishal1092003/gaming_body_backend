const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');
const {
  listUsers,
  creditUserBalance,
  resetUserPassword,
  createUserByAdmin,
} = require('../controllers/adminController');

const router = express.Router();

router.use(authenticate, requireAdmin);
router.get('/users', listUsers);
router.post('/users', createUserByAdmin);
router.post('/users/:userId/credit', creditUserBalance);
router.post('/users/:userId/reset-password', resetUserPassword);

module.exports = router;

const express = require('express');
const { login, register, logout, deleteOwnAccount, forgotPassword, resetPassword } = require('../controllers/authController');
const { authenticate } = require('../middleware/authMiddleware');
const { createAuthLimiter, createRegisterLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.post('/register', createRegisterLimiter(), register);
router.post('/login', createAuthLimiter(), login);
router.post('/logout', authenticate, logout);
router.delete('/me', authenticate, deleteOwnAccount);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;

const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { getSupportContext, createSupportTicket } = require('../controllers/supportController');

const router = express.Router();

router.get('/context', authenticate, getSupportContext);
router.post('/tickets', authenticate, createSupportTicket);

module.exports = router;

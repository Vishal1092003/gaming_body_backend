const express = require('express');
const {
  getSupportContext,
  createTicket,
  listTicketsAdmin,
  replyTicketAdmin,
} = require('../controllers/supportController');
const { authenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');

const router = express.Router();

router.use(authenticate);

router.get('/context', getSupportContext);
router.post('/tickets', createTicket);

// Admin
router.get('/tickets', requireAdmin, listTicketsAdmin);
router.post('/tickets/:ticketId/reply', requireAdmin, replyTicketAdmin);

module.exports = router;


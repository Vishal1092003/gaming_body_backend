const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');
const {
  getSupportContext,
  createSupportTicket,
  listMyTickets,
  listTicketsAdmin,
  replyTicketAdmin,
} = require('../controllers/supportController');

const router = express.Router();

router.use(authenticate);

router.get('/context', getSupportContext);
router.post('/tickets', createSupportTicket);
router.get('/my-tickets', listMyTickets);

// Admin inbox + replies
router.get('/tickets', requireAdmin, listTicketsAdmin);
router.post('/tickets/:ticketId/reply', requireAdmin, replyTicketAdmin);

module.exports = router;

const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../controllers/notificationController');

const router = express.Router();

router.use(authenticate);
router.get('/', listNotifications);
router.patch('/read-all', markAllNotificationsRead);
router.patch('/:notificationId/read', markNotificationRead);

module.exports = router;

const { query } = require('../config/db');

const listNotifications = async (req, res, next) => {
  try {
    const userId = Number(req.user?.sub);
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200);
    const result = await query(
      `SELECT TOP (${limit})
          id, type, title, message, entity_type, entity_id, target_path, is_read, created_at
       FROM notifications
       WHERE recipient_user_id = $1
       ORDER BY is_read ASC, created_at DESC`,
      [userId]
    );
    const unread = await query(
      'SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = $1 AND is_read = 0',
      [userId]
    );
    return res.json({
      notifications: result.rows || [],
      unreadCount: Number(unread.rows?.[0]?.count || 0),
    });
  } catch (error) {
    next(error);
  }
};

const markNotificationRead = async (req, res, next) => {
  try {
    const notificationId = Number(req.params.notificationId);
    const userId = Number(req.user?.sub);
    if (!Number.isInteger(notificationId) || notificationId <= 0) {
      return res.status(400).json({ error: 'Invalid notification id' });
    }
    await query(
      `UPDATE notifications
       SET is_read = 1, read_at = COALESCE(read_at, SYSUTCDATETIME())
       WHERE id = $1 AND recipient_user_id = $2`,
      [notificationId, userId]
    );
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};

const markAllNotificationsRead = async (req, res, next) => {
  try {
    await query(
      `UPDATE notifications
       SET is_read = 1, read_at = COALESCE(read_at, SYSUTCDATETIME())
       WHERE recipient_user_id = $1 AND is_read = 0`,
      [Number(req.user?.sub)]
    );
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};

module.exports = { listNotifications, markNotificationRead, markAllNotificationsRead };

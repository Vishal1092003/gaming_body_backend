const { query } = require('../config/db');

const createNotification = async ({
  recipientUserId,
  type,
  title,
  message,
  entityType,
  entityId,
  targetPath,
}) => {
  const recipientId = Number(recipientUserId);
  const relatedId = Number(entityId);
  if (!Number.isInteger(recipientId) || recipientId <= 0) return null;
  if (!String(type || '').trim() || !String(title || '').trim() || !String(message || '').trim()) return null;

  const result = await query(
    `IF NOT EXISTS (
       SELECT 1
       FROM notifications
       WHERE recipient_user_id = $1
         AND type = $2
         AND ISNULL(entity_type, '') = ISNULL($3, '')
         AND ISNULL(entity_id, 0) = ISNULL($4, 0)
     )
     BEGIN
       INSERT INTO notifications (recipient_user_id, type, title, message, entity_type, entity_id, target_path)
       OUTPUT INSERTED.id, INSERTED.recipient_user_id, INSERTED.type, INSERTED.title, INSERTED.message,
              INSERTED.entity_type, INSERTED.entity_id, INSERTED.target_path, INSERTED.is_read, INSERTED.created_at
       VALUES ($1, $2, $5, $6, $3, $4, $7)
     END`,
    [
      recipientId,
      String(type).trim(),
      entityType ? String(entityType).trim() : null,
      Number.isInteger(relatedId) && relatedId > 0 ? relatedId : null,
      String(title).trim().slice(0, 120),
      String(message).trim().slice(0, 400),
      targetPath ? String(targetPath).trim().slice(0, 240) : null,
    ]
  );

  return result.rows?.[0] || null;
};

const getManagingAdminIdForUser = async (userId) => {
  const result = await query(
    `SELECT TOP 1 COALESCE(u.created_by_admin_id, fallback_admin.id) AS admin_user_id
     FROM users u
     OUTER APPLY (
       SELECT TOP 1 id
       FROM users
       WHERE is_admin = 1
       ORDER BY id ASC
     ) fallback_admin
     WHERE u.id = $1`,
    [userId]
  );
  return Number(result.rows?.[0]?.admin_user_id || 0) || null;
};

const createNotificationsForAllAdmins = async (notification) => {
  const result = await query('SELECT id FROM users WHERE is_admin = 1');
  const adminIds = result.rows.map((row) => Number(row.id)).filter(Number.isInteger);
  await Promise.all(adminIds.map((recipientUserId) => createNotification({ ...notification, recipientUserId })));
};

module.exports = {
  createNotification,
  getManagingAdminIdForUser,
  createNotificationsForAllAdmins,
};

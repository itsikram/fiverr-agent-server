import { Activity } from '../models/Activity.js';

/**
 * Log a user activity to the database
 * @param {Object} req - Express request object
 * @param {string} type - Activity type (e.g., 'client_view', 'message_send', 'client_update')
 * @param {Object} data - Additional activity data
 */
export async function logActivity(req, type, data = {}) {
  try {
    // Only log for non-admin users
    if (!req.user || req.user.role === 'admin') {
      return;
    }

    const activity = new Activity({
      type,
      username: req.user.username,
      role: req.user.role,
      data,
    });

    await activity.save();
  } catch (error) {
    // Log errors but don't throw - activity logging should not break the main operation
    console.error('[ActivityLogger] Error logging activity:', error);
  }
}

/**
 * Middleware wrapper to easily log activities
 * Usage: app.get('/path', logActivityMiddleware('activity_type'), handler)
 */
export function logActivityMiddleware(activityType, dataExtractor = () => ({})) {
  return async (req, res, next) => {
    // Store the original json method
    const originalJson = res.json;

    // Override json method to log activity after successful response
    res.json = function (data) {
      // Only log on success (2xx status codes)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        logActivity(req, activityType, dataExtractor(req, data));
      }

      // Call the original json method
      return originalJson.call(this, data);
    };

    next();
  };
}

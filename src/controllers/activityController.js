import { Activity } from '../models/Activity.js';

/**
 * Record user activity
 */
export async function recordActivity(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Support both 'type' and 'activityType' field names
    const activityType = req.body.type || req.body.activityType;

    if (!activityType) {
      return res.status(400).json({ error: 'Missing activity type' });
    }

    const activity = new Activity({
      type: activityType,
      username: req.user.username,
      role: req.user.role,
      data: req.body.data || req.body,
    });

    await activity.save();

    res.json({ success: true, activity });
  } catch (error) {
    console.error('[Activity] Record activity error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get user's own activities
 */
export async function getUserActivities(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const activities = await Activity.find({ username: req.user.username })
      .sort({ created_at: -1 })
      .limit(100);

    res.json({ activities });
  } catch (error) {
    console.error('[Activity] Get user activities error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

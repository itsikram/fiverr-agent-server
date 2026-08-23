import express from 'express';
import { recordActivity, getUserActivities } from '../controllers/activityController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * POST /activities - Record user activity
 */
router.post('/', authenticate, recordActivity);

/**
 * GET /activities - Get user's activities
 */
router.get('/', authenticate, getUserActivities);

export default router;

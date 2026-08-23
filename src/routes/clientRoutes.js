import express from 'express';
import { getClients, getMyAssignments } from '../controllers/clientController.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /clients - Get clients list
 */
router.get('/', optionalAuth, getClients);

/**
 * GET /me/assignments - Get user's client assignments
 */
router.get('/me/assignments', authenticate, getMyAssignments);

export default router;
